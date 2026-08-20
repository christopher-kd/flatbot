import { describe, expect, spyOn, test } from "bun:test"
import { createListingsRoute } from "../api/routes/listings"
import type ListingRepository from "../db/repository/ListingRepository"
import type { ListingQueryResult } from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type { StoredApartmentListing } from "../types"

function makeStoredListing(
	overrides: Partial<StoredApartmentListing> = {},
): StoredApartmentListing {
	return {
		listingId: "WBM:1",
		propertyId: "1",
		organization: "WBM",
		lastSeenAt: Date.now(),
		firstSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://example.com/1",
		location: { city: "Berlin", street: "Teststr.", houseNumber: "1" },
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: {},
		accessibility: { wheelchair: null },
		images: [],
		...overrides,
	}
}

function makeFakeRepository(
	overrides: Partial<ListingRepository> = {},
): ListingRepository {
	return {
		updateListings: async () => {},
		findKnownBackfillFields: async () => new Map(),
		queryListings: async (): Promise<ListingQueryResult> => ({
			items: [],
			total: 0,
		}),
		findByListingId: async () => null,
		...overrides,
	}
}

describe("GET /listings", () => {
	test("returns paginated summaries on the happy path", async () => {
		const listing = makeStoredListing()
		const repository = makeFakeRepository({
			queryListings: async () => ({ items: [{ listing }], total: 1 }),
		})
		const app = createListingsRoute(repository)

		const res = await app.request("/")

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({
			total: 1,
			limit: 20,
			offset: 0,
			items: [
				{
					listingId: "WBM:1",
					organization: "WBM",
					title: "Test listing",
					rooms: 2,
					spaceQm: 50,
					costs: {},
					restrictions: { kind: "free" },
					images: [],
					fullUrl: "https://example.com/1",
					location: { city: "Berlin" },
				},
			],
		})
	})

	test("400 on invalid query params via zValidator", async () => {
		const app = createListingsRoute(makeFakeRepository())

		const res = await app.request("/?minPrice=notanumber")

		expect(res.status).toBe(400)
	})

	test("500 and logs on repository failure", async () => {
		const errorSpy = spyOn(log, "error").mockImplementation(() => log)
		const repository = makeFakeRepository({
			queryListings: async () => {
				throw new Error("db down")
			},
		})
		const app = createListingsRoute(repository)

		const res = await app.request("/")

		expect(res.status).toBe(500)
		expect(errorSpy).toHaveBeenCalled()
		errorSpy.mockRestore()
	})
})

describe("GET /listings/:listingId", () => {
	test("returns the listing on a hit", async () => {
		const listing = makeStoredListing()
		const repository = makeFakeRepository({
			findByListingId: async () => listing,
		})
		const app = createListingsRoute(repository)

		const res = await app.request("/WBM:1")

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.listingId).toBe("WBM:1")
	})

	test("404 on a miss", async () => {
		const app = createListingsRoute(makeFakeRepository())

		const res = await app.request("/does-not-exist")

		expect(res.status).toBe(404)
	})

	test("500 and logs on repository failure", async () => {
		const errorSpy = spyOn(log, "error").mockImplementation(() => log)
		const repository = makeFakeRepository({
			findByListingId: async () => {
				throw new Error("db down")
			},
		})
		const app = createListingsRoute(repository)

		const res = await app.request("/WBM:1")

		expect(res.status).toBe(500)
		expect(errorSpy).toHaveBeenCalled()
		errorSpy.mockRestore()
	})
})
