import type * as mongoDB from "mongodb"
import { type Collection, Double, type MongoClient } from "mongodb"
import log from "../../logger/logger"
import { checkListingLiveness } from "../../scraper/liveness"
import { required } from "../../scraper/util/assert"
import type {
	ApartmentListing,
	ArchivedApartmentListing,
	Organization,
	StoredApartmentListing,
} from "../../types"
import type ListingRepository from "./ListingRepository"
import { BACKFILL_FIELD_PATHS, type KnownBackfillFields } from "./ListingRepository"

// Storage writes a BSON Double in place of `number`, but the field still
// reads back as `number` everywhere else (Mongo/JS blur the two) - so a
// single cast lives here, once, instead of at every call site below.
function toDouble<T extends number | undefined>(value: T): T {
	return (value === undefined ? undefined : new Double(value)) as T
}

// Ensures numeric fields are always written as BSON double (never int32) and
// wbsLevels is always an array (never null/undefined), regardless of what
// shape the scraper produced it in — so consumers in other languages (e.g. a
// Kotlin client) see one consistent wire type instead of per-doc drift.
function normalizeForStorage(listing: ApartmentListing): ApartmentListing {
	return {
		...listing,
		spaceQm: toDouble(listing.spaceQm),
		rooms: toDouble(listing.rooms),
		costs: {
			...listing.costs,
			coldRentEur: toDouble(listing.costs.coldRentEur),
			utilityEur: toDouble(listing.costs.utilityEur),
			heatingEur: toDouble(listing.costs.heatingEur),
			totalRentEur: toDouble(listing.costs.totalRentEur),
			depositEur: toDouble(listing.costs.depositEur),
		},
		// restrictions is typed as required, but Vonovia/Deutsche Wohnen ship
		// `restrictions: null` at runtime (see VonoviaGroupScraper) — guard the
		// whole object before touching its fields, same as merge.ts does.
		restrictions: listing.restrictions && {
			...listing.restrictions,
			wbsLevels:
				listing.restrictions.wbsLevels == null
					? []
					: Array.isArray(listing.restrictions.wbsLevels)
						? listing.restrictions.wbsLevels
						: [listing.restrictions.wbsLevels],
		},
		// accessibility itself must always be an object (never null/undefined)
		// so consumers can rely on the key existing — individual flags inside
		// stay null when unknown rather than being omitted.
		accessibility: {
			senior: listing.accessibility?.senior ?? null,
			wheelchair: listing.accessibility?.wheelchair ?? null,
			barrierFree: listing.accessibility?.barrierFree ?? null,
		},
		// images is typed as an array, but has been seen stored as a lone
		// image document instead of a one-element array — normalize the same
		// way wbsLevels is above.
		images:
			listing.images == null
				? []
				: Array.isArray(listing.images)
					? listing.images
					: [listing.images],
	}
}

// Reads a dot-path (e.g. "costs.depositEur") off an untyped object graph -
// paired with setPath below to generically pluck BACKFILL_FIELD_PATHS onto a
// KnownBackfillFields result without hand-listing each field.
function getPath(obj: Record<string, unknown>, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>(
			(value, key) =>
				value && typeof value === "object"
					? (value as Record<string, unknown>)[key]
					: undefined,
			obj,
		)
}

// Writes `value` at a dot-path, creating intermediate objects as needed.
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".")
	let target = obj
	for (const key of keys.slice(0, -1)) {
		if (typeof target[key] !== "object" || target[key] === null) {
			target[key] = {}
		}
		target = target[key] as Record<string, unknown>
	}
	target[keys[keys.length - 1]] = value
}

function toUpsertOps(
	listings: ApartmentListing[],
): mongoDB.AnyBulkWriteOperation<StoredApartmentListing>[] {
	return listings.map((listing) => {
		const normalized = normalizeForStorage(listing)
		return {
			updateOne: {
				// listingId (organization:propertyId) is always populated by
				// Scraper.fetchListings() before listings reach here.
				filter: {
					listingId: required(normalized.listingId, "listing.listingId"),
				},
				update: {
					$set: normalized,
					$setOnInsert: { firstSeenAt: Date.now() },
				},
				upsert: true,
			},
		}
	})
}

export default class MongoListingRepository implements ListingRepository {
	#mongoClient: MongoClient
	#listingCollection: mongoDB.Collection<StoredApartmentListing>
	#archiveCollection: Collection<ArchivedApartmentListing>

	constructor(
		mongoClient: MongoClient,
		listingCollection: Collection<StoredApartmentListing>,
		archiveCollection: Collection<ArchivedApartmentListing>,
	) {
		this.#listingCollection = listingCollection
		this.#mongoClient = mongoClient
		this.#archiveCollection = archiveCollection
	}

	async findKnownBackfillFields(
		listingIds: string[],
	): Promise<Map<string, KnownBackfillFields>> {
		if (listingIds.length === 0) return new Map()

		const docs = await this.#listingCollection
			.find({ listingId: { $in: listingIds } })
			.toArray()

		const result = new Map<string, KnownBackfillFields>()
		for (const doc of docs) {
			const fields: KnownBackfillFields = {}
			for (const path of BACKFILL_FIELD_PATHS) {
				const value = getPath(doc as Record<string, unknown>, path)
				if (value !== undefined) {
					setPath(fields as unknown as Record<string, unknown>, path, value)
				}
			}
			result.set(doc.listingId, fields)
		}
		return result
	}

	async updateListings(
		listings: ApartmentListing[],
		scrapedOrganizations: Organization[],
	): Promise<void> {
		const processedListingIds = listings.map((l) =>
			required(l.listingId, "listing.listingId"),
		)
		const archiveFilter = {
			organization: { $in: scrapedOrganizations },
			listingId: { $nin: processedListingIds },
		}
		// Read outside the transaction: liveness checks below hit external
		// landlord sites, and holding a Mongo transaction open across
		// unpredictable network calls risks the transaction timing out. This
		// script runs to completion single-shot (no concurrent writers), so
		// there's no consistency loss from computing the candidate list here.
		const untouchedDocs = await this.#listingCollection
			.find(archiveFilter)
			.toArray()

		// Presence alone can be a transient scrape miss, or a listing the
		// landlord quietly delisted while keeping it live at its own URL - see
		// checkListingLiveness. For orgs without a real check yet, that returns
		// "not-implemented" and we fall back to archiving on presence alone, as
		// before.
		const docsToArchive: StoredApartmentListing[] = []
		for (const doc of untouchedDocs) {
			log.info(`Checking liveness of ${doc.propertyId} before archiving...`)
			const liveness = await checkListingLiveness(doc)
			if (liveness !== "active") {
				log.info(" -> Yup, it's dead and can be archived.")
				docsToArchive.push(doc)
			}
		}

		const session = this.#mongoClient.startSession()

		try {
			session.startTransaction()

			await this.#listingCollection.bulkWrite(toUpsertOps(listings), {
				session,
			})

			if (docsToArchive.length > 0) {
				const archivedDocs: ArchivedApartmentListing[] = docsToArchive.map(
					(doc) => ({
						...doc,
						archivedAt: Date.now(),
					}),
				)
				await this.#archiveCollection.insertMany(archivedDocs, { session })

				await this.#listingCollection.deleteMany(
					{ listingId: { $in: docsToArchive.map((d) => d.listingId) } },
					{ session },
				)
			}

			await session.commitTransaction()
		} catch (err) {
			log.error(err)
			throw err
		}

		return
	}
}
