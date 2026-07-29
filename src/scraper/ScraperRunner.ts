import type MongoDatabaseClient from "../db/MongoDatabaseClient"
import type ListingRepository from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type { ApartmentListing, Organization } from "../types"
import {
	fillMissingCoordinates,
	hydrateKnownBackfillFields,
	runScraperBackfills,
} from "./backfill"
import type PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import {
	logScraperError,
	logScraperResult,
	logSummary,
	logTableHeader,
	printBanner,
} from "./consoleReport"
import { mergeAggregatorListings } from "./merge"

const CITY = "Berlin"

interface ScraperRunnerParams {
	directScrapers: Scraper[]
	aggregatorScraper: Scraper
	listingRepository: ListingRepository
	dbClient: MongoDatabaseClient
	photonClient: PhotonClient
}

interface ScraperRunResult {
	organization: Organization
	listings: ApartmentListing[]
	success: boolean
}

class ScraperRunner {
	#directScrapers: Scraper[]
	#aggregatorScraper: Scraper
	#listingRepository: ListingRepository
	#dbClient: MongoDatabaseClient
	#photonClient: PhotonClient

	constructor(params: ScraperRunnerParams) {
		this.#directScrapers = params.directScrapers
		this.#aggregatorScraper = params.aggregatorScraper
		this.#listingRepository = params.listingRepository
		this.#dbClient = params.dbClient
		this.#photonClient = params.photonClient
	}

	public async run(): Promise<void> {
		await printBanner()

		const startingTime = Date.now()

		try {
			await this.healthcheckPhase()

			log.info("Searching for new flats...")
			const { listings, scrapedOrganizations } = await this.scrape()

			logSummary(listings.length, Date.now() - startingTime)

			log.info("Hydrating already-known backfill fields from the database...")
			await hydrateKnownBackfillFields(this.#listingRepository, listings)

			log.info("Running per-scraper backfills...")
			await runScraperBackfills(this.#directScrapers, listings)

			log.info("Filling in missing coordinates with Photon...")
			const coordsBatch1 = listings.filter(
				(l) =>
					l.organization === "Stadt und Land" ||
					l.organization === "Berlinovo" ||
					l.organization === "Gewobag",
			)
			const coordsBatch2 = listings.filter((l) => l.organization === "degewo")
			await Promise.all([
				fillMissingCoordinates(
					this.#photonClient,
					coordsBatch1,
					(l) => `${l.street} ${l.houseNumber}, ${l.postalCode} ${CITY}`,
				),
				fillMissingCoordinates(
					this.#photonClient,
					coordsBatch2,
					(l) => `${l.street} ${l.houseNumber}, ${CITY} ${l.neighborhood}`,
				),
			])

			await this.persist(listings, scrapedOrganizations)
		} finally {
			await this.disconnect()
		}

		log.info("Bye, bye!")
	}

	private async healthcheckPhase(): Promise<void> {
		log.info("Performing healthcheck on Photon endpoint...")
		const healthy = await this.#photonClient.healthcheck()
		if (!healthy)
			throw new Error(
				"Couldn't establish connection to Photon endpoint. " +
					"Make sure the service is running and reachable.",
			)
	}

	private async scrape(): Promise<{
		listings: ApartmentListing[]
		scrapedOrganizations: Organization[]
	}> {
		logTableHeader()

		const [directRunResults, aggregatorRunResult] = await Promise.all([
			Promise.all(
				this.#directScrapers.map((scraper) => this.runScraper(scraper)),
			),
			this.runScraper(this.#aggregatorScraper),
		])

		const scrapedOrganizations: Organization[] = directRunResults
			.filter((r) => r.success)
			.map((r) => r.organization)

		const listings: ApartmentListing[] = mergeAggregatorListings(
			directRunResults.flatMap((r) => r.listings),
			aggregatorRunResult.listings,
		)

		return { listings, scrapedOrganizations }
	}

	private async runScraper(scraper: Scraper): Promise<ScraperRunResult> {
		const scraperStart = Date.now()
		try {
			const result = await scraper.fetchListings()
			logScraperResult(
				scraper.organization,
				result.length,
				Date.now() - scraperStart,
				scraper.getRequestCount(),
			)
			return {
				organization: scraper.organization,
				listings: result,
				success: true,
			}
		} catch (err) {
			logScraperError(scraper.organization, Date.now() - scraperStart)
			log.error(err)
			return {
				organization: scraper.organization,
				listings: [],
				success: false,
			}
		}
	}

	private async persist(
		listings: ApartmentListing[],
		scrapedOrganizations: Organization[],
	): Promise<void> {
		log.info("Saving results...")
		await this.#listingRepository.updateListings(listings, scrapedOrganizations)
	}

	private async disconnect(): Promise<void> {
		log.info("Shutting down safely...")
		await this.#dbClient.disconnect()
	}
}

export default ScraperRunner
