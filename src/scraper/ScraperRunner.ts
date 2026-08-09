import type MongoDatabaseClient from "../db/MongoDatabaseClient"
import type ListingRepository from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type {
	ApartmentListing,
	ApartmentListingLocation,
	Organization,
} from "../types"
import {
	fillMissingCoordinates,
	hydrateKnownBackfillFields,
	pruneDeadAggregatorOnlyListings,
	runScraperBackfills,
} from "./backfill"
import { logSummary, printBanner, runScrapersPlain } from "./consoleReport"
import {
	runCoordinateFillWithLiveBoard,
	runFetchAndMergeWithLiveBoard,
	runHydrateAndBackfillWithLiveBoard,
	runPersistWithLiveBoard,
} from "./liveBoard"
import { mergeDirectAndAggregatorListings } from "./merge"
import type PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import type { ScraperRunResult } from "./ScraperRunner.types"
import { getLogStyle } from "./util/logStyle"

const CITY = "Berlin"

interface ScraperRunnerParams {
	directScrapers: Scraper[]
	aggregatorScraper: Scraper
	listingRepository: ListingRepository
	dbClient: MongoDatabaseClient
	photonClient: PhotonClient
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
		const dynamic = getLogStyle() === "dynamic"

		try {
			log.info("Searching for new flats...")
			const { listings, scrapedOrganizations } = dynamic
				? await this.scrapeDynamic()
				: await this.scrapePlain()

			logSummary(listings.length, Date.now() - startingTime)

			if (dynamic) {
				await runHydrateAndBackfillWithLiveBoard({
					listingRepository: this.#listingRepository,
					directScrapers: this.#directScrapers,
					listings,
				})
			} else {
				log.info(
					"Hydrating already-known backfill fields from the database...",
				)
				await hydrateKnownBackfillFields(this.#listingRepository, listings)

				log.info("Running per-scraper backfills...")
				await runScraperBackfills(this.#directScrapers, listings)
			}

			const coordsBatch1 = listings.filter(
				(l) =>
					l.organization === "Stadt und Land" ||
					l.organization === "Berlinovo" ||
					l.organization === "Gewobag",
			)
			const coordsBatch2 = listings.filter((l) => l.organization === "degewo")
			const addressFor1 = (l: ApartmentListingLocation) =>
				`${l.street} ${l.houseNumber}, ${l.postalCode} ${CITY}`
			const addressFor2 = (l: ApartmentListingLocation) =>
				`${l.street} ${l.houseNumber}, ${CITY} ${l.neighborhood}`

			if (dynamic) {
				await runCoordinateFillWithLiveBoard({
					photonClient: this.#photonClient,
					batches: [
						{
							label: "Stadt und Land, Berlinovo, Gewobag",
							listings: coordsBatch1,
							addressFor: addressFor1,
						},
						{ label: "degewo", listings: coordsBatch2, addressFor: addressFor2 },
					],
				})
			} else {
				log.info("Checking Photon connection for coordinate backfill...")
				const photonHealthy = await this.#photonClient.healthcheck()
				if (photonHealthy) {
					log.info("Filling in missing coordinates with Photon...")
					await Promise.all([
						fillMissingCoordinates(this.#photonClient, coordsBatch1, addressFor1),
						fillMissingCoordinates(this.#photonClient, coordsBatch2, addressFor2),
					])
				} else {
					log.warn("Photon unreachable — skipping coordinate backfill this run.")
				}
			}

			if (dynamic) {
				await runPersistWithLiveBoard({
					listingRepository: this.#listingRepository,
					listings,
					scrapedOrganizations,
				})
			} else {
				await this.persist(listings, scrapedOrganizations)
			}
		} finally {
			await this.disconnect()
		}

		log.info("Bye, bye!")
	}

	private async scrapeDynamic(): Promise<{
		listings: ApartmentListing[]
		scrapedOrganizations: Organization[]
	}> {
		return runFetchAndMergeWithLiveBoard({
			directScrapers: this.#directScrapers,
			aggregatorScraper: this.#aggregatorScraper,
			execute: (scraper) => this.executeScraper(scraper),
		})
	}

	private async scrapePlain(): Promise<{
		listings: ApartmentListing[]
		scrapedOrganizations: Organization[]
	}> {
		const allScrapers = [...this.#directScrapers, this.#aggregatorScraper]
		const execute = (scraper: Scraper) => this.executeScraper(scraper)

		const results = await runScrapersPlain(allScrapers, execute)

		const aggregatorRunResult = results[results.length - 1]
		const directRunResults = results.slice(0, -1)

		const scrapedOrganizations: Organization[] = directRunResults
			.filter((r) => r.success)
			.map((r) => r.organization)

		const { merged, directListingIds } = mergeDirectAndAggregatorListings(
			directRunResults,
			aggregatorRunResult.listings,
		)

		log.info("Checking for dead listings from secondary sources...")
		const listings = await pruneDeadAggregatorOnlyListings(
			merged,
			directListingIds,
		)

		return { listings, scrapedOrganizations }
	}

	private async executeScraper(scraper: Scraper): Promise<ScraperRunResult> {
		const scraperStart = Date.now()
		try {
			const listings = await scraper.fetchListings()
			return {
				organization: scraper.organization,
				listings,
				success: true,
				durationMs: Date.now() - scraperStart,
				requestsCount: scraper.getRequestCount(),
			}
		} catch (err) {
			log.error(`${scraper.organization}: scrape failed: ${err}`)
			return {
				organization: scraper.organization,
				listings: [],
				success: false,
				durationMs: Date.now() - scraperStart,
				requestsCount: scraper.getRequestCount(),
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
