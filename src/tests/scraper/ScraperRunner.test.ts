import { describe, expect, mock, test } from "bun:test"
import type MongoDatabaseClient from "../../db/MongoDatabaseClient"
import type ListingRepository from "../../db/repository/ListingRepository"
import * as realConsoleReport from "../../scraper/consoleReport"
import type PhotonClient from "../../scraper/PhotonClient"
import type Scraper from "../../scraper/Scraper"
import ScraperRunner from "../../scraper/ScraperRunner"
import type {
	ApartmentListing,
	ApartmentListingLocationCoordinates,
	Organization,
} from "../../types"

// consoleReport.printBanner reads flavor-text file for console art -
// stub out so tests don't depend on that file existing.
mock.module("../../scraper/consoleReport", () => ({
	...realConsoleReport,
	printBanner: async () => {},
}))

// Forces ScraperRunner.run() down the plain (LOG_STYLE=normal) path.
// The dynamic path only differs in Listr terminal rendering
process.env.LOG_STYLE = "normal"

async function expectToThrow(
	promise: Promise<unknown>,
	expected: string | RegExp,
): Promise<void> {
	let thrown: unknown
	try {
		await promise
	} catch (err) {
		thrown = err
	}
	expect(thrown).toBeInstanceOf(Error)
	expect((thrown as Error).message).toMatch(expected)
}

function makeListing(
	organization: Organization,
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization,
		listingId: `${organization}:1`,
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://example.com/1",
		location: { city: "Berlin", street: "Teststr.", houseNumber: "1" },
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: {},
		images: [],
		...overrides,
	}
}

function makeScraper(
	organization: Organization,
	opts: {
		listings?: ApartmentListing[]
		fetchError?: Error
		fetchListings?: () => Promise<ApartmentListing[]>
	} = {},
): Scraper {
	return {
		organization,
		fetchListings:
			opts.fetchListings ??
			(async () => {
				if (opts.fetchError) throw opts.fetchError
				return opts.listings ?? []
			}),
		getRequestCount: () => 0,
		backfill: async () => {},
	} as unknown as Scraper
}

function mockUpdateListings() {
	return mock(
		async (
			_listings: ApartmentListing[],
			_scrapedOrganizations: Organization[],
		) => {},
	)
}

function makeRepository(
	updateListings = mockUpdateListings(),
): ListingRepository {
	return {
		updateListings,
		findKnownBackfillFields: mock(async () => new Map()),
	} as unknown as ListingRepository
}

function makeDbClient(disconnect = mock(async () => {})): MongoDatabaseClient {
	return { disconnect } as unknown as MongoDatabaseClient
}

function makePhotonClient(
	overrides: {
		healthcheck?: () => Promise<boolean>
		fetchCoordinates?: (
			address: string,
		) => Promise<ApartmentListingLocationCoordinates | null>
	} = {},
): PhotonClient {
	return {
		healthcheck: overrides.healthcheck ?? (async () => true),
		fetchCoordinates: overrides.fetchCoordinates ?? (async () => null),
	} as unknown as PhotonClient
}

function makeRunner(
	params: {
		directScrapers?: Scraper[]
		aggregatorScraper?: Scraper
		listingRepository?: ListingRepository
		dbClient?: MongoDatabaseClient
		photonClient?: PhotonClient
	} = {},
): ScraperRunner {
	return new ScraperRunner({
		directScrapers: params.directScrapers ?? [],
		aggregatorScraper:
			params.aggregatorScraper ?? makeScraper("inberlinwohnen"),
		listingRepository: params.listingRepository ?? makeRepository(),
		dbClient: params.dbClient ?? makeDbClient(),
		photonClient: params.photonClient ?? makePhotonClient(),
	})
}

describe("ScraperRunner.run", () => {
	test("a scraper that throws doesn't abort the run, its org is excluded from scrapedOrganizations", async () => {
		const updateListings = mockUpdateListings()
		const failing = makeScraper("HOWOGE", { fetchError: new Error("boom") })
		const succeeding = makeScraper("WBM", { listings: [makeListing("WBM")] })

		await makeRunner({
			directScrapers: [failing, succeeding],
			listingRepository: makeRepository(updateListings),
		}).run()

		expect(updateListings).toHaveBeenCalledTimes(1)
		const [listings, scrapedOrganizations] = updateListings.mock.calls[0] as [
			ApartmentListing[],
			Organization[],
		]
		expect(scrapedOrganizations).toEqual(["WBM"])
		expect(listings.map((l) => l.organization)).toEqual(["WBM"])
	})

	test("merges aggregator listings into the direct pool for a matching listingId", async () => {
		const direct = makeScraper("WBM", {
			listings: [makeListing("WBM", { features: undefined })],
		})
		const aggregator = makeScraper("inberlinwohnen", {
			listings: [makeListing("WBM", { features: ["Balkon"] })],
		})
		const updateListings = mockUpdateListings()

		await makeRunner({
			directScrapers: [direct],
			aggregatorScraper: aggregator,
			listingRepository: makeRepository(updateListings),
		}).run()

		const [listings] = updateListings.mock.calls[0] as [
			ApartmentListing[],
			Organization[],
		]
		expect(listings).toHaveLength(1)
		expect(listings[0].features).toEqual(["Balkon"])
	})

	test("batches coordinate backfill by organization with the right address format", async () => {
		const calls: string[] = []
		const photonClient = makePhotonClient({
			fetchCoordinates: async (address) => {
				calls.push(address)
				return { type: "Point", coordinates: [2, 1] }
			},
		})
		const gewobag = makeScraper("Gewobag", {
			listings: [
				makeListing("Gewobag", {
					location: {
						city: "Berlin",
						street: "Foostr.",
						houseNumber: "5",
						postalCode: "10115",
					},
				}),
			],
		})
		const degewo = makeScraper("degewo", {
			listings: [
				makeListing("degewo", {
					location: {
						city: "Berlin",
						street: "Barstr.",
						houseNumber: "9",
						neighborhood: "Mitte",
					},
				}),
			],
		})
		// WBM never populates coordinates from its own site (100%
		// aggregator-dependent), HOWOGE's project-teaser-sourced listings
		// never get coordinates either - both share Gewobag's address format.
		const wbm = makeScraper("WBM", {
			listings: [
				makeListing("WBM", {
					location: {
						city: "Berlin",
						street: "Bazstr.",
						houseNumber: "3",
						postalCode: "10115",
					},
				}),
			],
		})
		const howoge = makeScraper("HOWOGE", {
			listings: [
				makeListing("HOWOGE", {
					location: {
						city: "Berlin",
						street: "Quuxstr.",
						houseNumber: "7",
						postalCode: "10115",
					},
				}),
			],
		})
		// GESOBAU isn't in either coordinate batch - its undefined coordinates
		// should never trigger a Photon call at all.
		const gesobau = makeScraper("GESOBAU", {
			listings: [
				makeListing("GESOBAU", {
					location: {
						city: "Berlin",
						street: "Quxstr.",
						houseNumber: "1",
						postalCode: "10115",
					},
				}),
			],
		})

		await makeRunner({
			directScrapers: [gewobag, degewo, wbm, howoge, gesobau],
			photonClient,
		}).run()

		expect(calls).toContain("Foostr. 5, 10115 Berlin")
		expect(calls).toContain("Barstr. 9, Berlin Mitte")
		expect(calls).toContain("Bazstr. 3, 10115 Berlin")
		expect(calls).toContain("Quuxstr. 7, 10115 Berlin")
		expect(calls).toHaveLength(4)
	})

	test("still scrapes and persists when the Photon healthcheck fails, just skips coordinate backfill", async () => {
		const fetchListings = mock(async () => [
			makeListing("Gewobag", {
				location: {
					city: "Berlin",
					street: "Foostr.",
					houseNumber: "5",
					postalCode: "10115",
				},
			}),
		])
		const scraper = makeScraper("Gewobag", { fetchListings })
		const disconnect = mock(async () => {})
		const fetchCoordinates = mock(async () => ({
			type: "Point" as const,
			coordinates: [2, 1] as [number, number],
		}))
		const updateListings = mockUpdateListings()

		const runner = makeRunner({
			directScrapers: [scraper],
			photonClient: makePhotonClient({
				healthcheck: async () => false,
				fetchCoordinates,
			}),
			dbClient: makeDbClient(disconnect),
			listingRepository: makeRepository(updateListings),
		})

		await runner.run()

		expect(fetchListings).toHaveBeenCalledTimes(1)
		expect(fetchCoordinates).not.toHaveBeenCalled()
		expect(updateListings).toHaveBeenCalledTimes(1)
		expect(disconnect).toHaveBeenCalledTimes(1)
	})

	test("persists merged listings and every scraped organization", async () => {
		const updateListings = mockUpdateListings()
		const howoge = makeScraper("HOWOGE", { listings: [makeListing("HOWOGE")] })
		const wbm = makeScraper("WBM", { listings: [makeListing("WBM")] })

		await makeRunner({
			directScrapers: [howoge, wbm],
			listingRepository: makeRepository(updateListings),
		}).run()

		expect(updateListings).toHaveBeenCalledTimes(1)
		const [listings, scrapedOrganizations] = updateListings.mock.calls[0] as [
			ApartmentListing[],
			Organization[],
		]
		expect([...scrapedOrganizations].sort()).toEqual(["HOWOGE", "WBM"])
		expect(listings.map((l) => l.listingId).sort()).toEqual([
			"HOWOGE:1",
			"WBM:1",
		])
	})

	test("disconnects even when persisting fails", async () => {
		const disconnect = mock(async () => {})
		const updateListings = mock(async () => {
			throw new Error("db write failed")
		})

		const runner = makeRunner({
			listingRepository: makeRepository(updateListings),
			dbClient: makeDbClient(disconnect),
		})

		await expectToThrow(runner.run(), "db write failed")
		expect(disconnect).toHaveBeenCalledTimes(1)
	})
})
