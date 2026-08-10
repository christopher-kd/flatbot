import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test"
import { type Collection, MongoClient } from "mongodb"
import MongoListingRepository from "../db/repository/MongoListingRepository"
import type {
	ApartmentListing,
	ArchivedApartmentListing,
	Organization,
	StoredApartmentListing,
} from "../types"

// These tests hit a real MongoDB replica set (transactions require one) on
// an isolated, disposable database.
// Skips cleanly (not fail) if no reachable Mongo is configured.
const TEST_DB_NAME = "flatbot_test_mongolistingrepository"
const CONN_STRING = process.env.DB_CONN_STRING

async function canConnect(uri: string): Promise<boolean> {
	const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 })
	try {
		await probe.connect()
		await probe.db("admin").command({ ping: 1 })
		return true
	} catch {
		return false
	} finally {
		await probe.close()
	}
}

const mongoAvailable = CONN_STRING ? await canConnect(CONN_STRING) : false

function makeListing(
	organization: Organization,
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		listingId: `${organization}:1`,
		organization,
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://example.com/listing/1",
		location: { city: "Berlin", street: "Teststr.", houseNumber: "1" },
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: {},
		images: [],
		...overrides,
	}
}

describe.skipIf(!mongoAvailable)("MongoListingRepository (integration)", () => {
	let client: MongoClient
	let listingCollection: Collection<StoredApartmentListing>
	let archiveCollection: Collection<ArchivedApartmentListing>
	let repository: MongoListingRepository

	beforeAll(async () => {
		client = new MongoClient(CONN_STRING as string, { ignoreUndefined: true })
		await client.connect()
		const db = client.db(TEST_DB_NAME)
		listingCollection = db.collection<StoredApartmentListing>("listings")
		archiveCollection =
			db.collection<ArchivedApartmentListing>("listings_archive")
		repository = new MongoListingRepository(
			client,
			listingCollection,
			archiveCollection,
		)
	})

	afterEach(async () => {
		await listingCollection.deleteMany({})
		await archiveCollection.deleteMany({})
		mock.restore()
	})

	afterAll(async () => {
		await client.db(TEST_DB_NAME).dropDatabase()
		await client.close()
	})

	async function bsonTypeOf(
		listingId: string,
		field: string,
	): Promise<string | undefined> {
		const [doc] = await listingCollection
			.aggregate([
				{ $match: { listingId } },
				{ $project: { t: { $type: `$${field}` } } },
			])
			.toArray()
		return doc?.t
	}

	async function bsonTypeOfArrayElem(
		listingId: string,
		field: string,
		index: number,
	): Promise<string | undefined> {
		const [doc] = await listingCollection
			.aggregate([
				{ $match: { listingId } },
				{
					$project: {
						t: { $type: { $arrayElemAt: [`$${field}`, index] } },
					},
				},
			])
			.toArray()
		return doc?.t
	}

	describe("updateListings - BSON numeric typing", () => {
		test("stores numeric fields as BSON double, never int32, even for whole numbers", async () => {
			const listing = makeListing("WBM", {
				spaceQm: 50,
				rooms: 2,
				costs: {
					coldRentEur: 500,
					utilityEur: 100,
					heatingEur: 50,
					totalRentEur: 650,
					depositEur: 1500,
				},
				location: {
					city: "Berlin",
					street: "Teststr.",
					houseNumber: "1",
					coordinates: { type: "Point", coordinates: [13, 52] },
				},
			})

			await repository.updateListings([listing], ["WBM"])

			for (const field of [
				"spaceQm",
				"rooms",
				"costs.coldRentEur",
				"costs.utilityEur",
				"costs.heatingEur",
				"costs.totalRentEur",
				"costs.depositEur",
			]) {
				expect(await bsonTypeOf("WBM:1", field)).toBe("double")
			}
			expect(
				await bsonTypeOfArrayElem(
					"WBM:1",
					"location.coordinates.coordinates",
					0,
				),
			).toBe("double")
			expect(
				await bsonTypeOfArrayElem(
					"WBM:1",
					"location.coordinates.coordinates",
					1,
				),
			).toBe("double")
		})

		test("keeps a confirmed-absent numeric field as null, not Double(0)", async () => {
			const listing = makeListing("WBM", { costs: { coldRentEur: null } })
			await repository.updateListings([listing], ["WBM"])
			expect(await bsonTypeOf("WBM:1", "costs.coldRentEur")).toBe("null")
		})

		test("omits a not-yet-attempted field entirely instead of writing null", async () => {
			const listing = makeListing("WBM", { costs: {} })
			await repository.updateListings([listing], ["WBM"])
			expect(await bsonTypeOf("WBM:1", "costs.coldRentEur")).toBe("missing")
		})
	})

	describe("updateListings - upsert semantics", () => {
		test("doesn't clobber an already-known DB value when this run leaves it undefined", async () => {
			await repository.updateListings(
				[makeListing("WBM", { costs: { coldRentEur: 500 } })],
				["WBM"],
			)

			await repository.updateListings(
				[makeListing("WBM", { costs: { heatingEur: 50 } })],
				["WBM"],
			)

			const doc = await listingCollection.findOne({ listingId: "WBM:1" })
			expect(doc?.costs.coldRentEur).toBe(500)
			expect(doc?.costs.heatingEur).toBe(50)
		})

		test("sets firstSeenAt only on insert, never rewrites it on update", async () => {
			await repository.updateListings([makeListing("WBM")], ["WBM"])
			const inserted = await listingCollection.findOne({ listingId: "WBM:1" })
			const firstSeenAt = inserted?.firstSeenAt
			expect(firstSeenAt).toBeDefined()

			await repository.updateListings(
				[makeListing("WBM", { title: "Updated title" })],
				["WBM"],
			)
			const updated = await listingCollection.findOne({ listingId: "WBM:1" })

			expect(updated?.firstSeenAt).toBe(firstSeenAt as number)
			expect(updated?.title).toBe("Updated title")
		})

		test("throws synchronously for a listing missing listingId, before touching the DB", async () => {
			const listing = makeListing("WBM")
			delete listing.listingId

			let thrown: unknown
			try {
				await repository.updateListings([listing], ["WBM"])
			} catch (err) {
				thrown = err
			}

			expect(thrown).toBeInstanceOf(Error)
			expect(await listingCollection.countDocuments({})).toBe(0)
		})
	})

	describe("updateListings - archiving", () => {
		test("archives an untouched listing on presence alone for an org with no real liveness check", async () => {
			// WBM has no real liveness check ("not-implemented") - falls back
			// to archiving on presence alone, per liveness.ts.
			await repository.updateListings([makeListing("WBM")], ["WBM"])

			// This run's fresh scrape came back empty for WBM - the previously
			// stored listing is now "untouched".
			await repository.updateListings([], ["WBM"])

			expect(await listingCollection.countDocuments({})).toBe(0)
			const archived = await archiveCollection.findOne({ listingId: "WBM:1" })
			expect(archived).not.toBeNull()
			expect(archived?.archivedAt).toBeDefined()
		})

		test("keeps an untouched listing whose liveness check reports active", async () => {
			await repository.updateListings([makeListing("GESOBAU")], ["GESOBAU"])

			spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
			await repository.updateListings([], ["GESOBAU"])

			expect(await listingCollection.countDocuments({})).toBe(1)
			expect(await archiveCollection.countDocuments({})).toBe(0)
		})

		test("archives an untouched listing whose liveness check reports inactive", async () => {
			await repository.updateListings([makeListing("GESOBAU")], ["GESOBAU"])

			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("not found", { status: 404 }),
			)
			await repository.updateListings([], ["GESOBAU"])

			expect(await listingCollection.countDocuments({})).toBe(0)
			expect(await archiveCollection.countDocuments({})).toBe(1)
		})

		test("leaves a listing alone if its organization wasn't scraped this run", async () => {
			const fetchSpy = spyOn(globalThis, "fetch")
			await repository.updateListings([makeListing("HOWOGE")], ["HOWOGE"])

			// HOWOGE isn't in scrapedOrganizations this time - shouldn't even be
			// considered for archiving, let alone liveness-checked.
			await repository.updateListings([], ["WBM"])

			expect(await listingCollection.countDocuments({})).toBe(1)
			expect(fetchSpy).not.toHaveBeenCalled()
		})
	})

	describe("findKnownBackfillFields", () => {
		test("returns empty map without querying for an empty input", async () => {
			const result = await repository.findKnownBackfillFields([])
			expect(result.size).toBe(0)
		})

		test("plucks only the known backfillable fields, keyed by listingId", async () => {
			await repository.updateListings(
				[
					makeListing("WBM", {
						spaceQm: 50,
						newBuilding: true,
						costs: { coldRentEur: 500, heatingEur: null },
						location: {
							city: "Berlin",
							street: "Teststr.",
							houseNumber: "1",
							coordinates: { type: "Point", coordinates: [13, 52] },
						},
						features: ["Balkon"],
						accessibility: { barrierFree: true },
					}),
				],
				["WBM"],
			)

			const result = await repository.findKnownBackfillFields(["WBM:1"])
			const fields = result.get("WBM:1")

			expect(fields?.spaceQm).toBe(50)
			expect(fields?.newBuilding).toBe(true)
			expect(fields?.costs?.coldRentEur).toBe(500)
			expect(fields?.costs?.heatingEur).toBe(null)
			expect(fields?.costs?.utilityEur).toBeUndefined()
			expect(fields?.location?.coordinates).toEqual({
				type: "Point",
				coordinates: [13, 52],
			})
			expect(fields?.features).toEqual(["Balkon"])
			expect(fields?.accessibility?.barrierFree).toBe(true)
		})
	})
})
