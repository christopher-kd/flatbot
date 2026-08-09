import dlv from "dlv"
import { dset } from "dset"
import type * as mongoDB from "mongodb"
import { type Collection, Double, type MongoClient } from "mongodb"
import log from "../../logger/logger"
import { checkListingLiveness } from "../../scraper/liveness"
import { required } from "../../scraper/util/assert"
import { runConcurrent } from "../../scraper/util/concurrency"
import { groupByOrganization } from "../../scraper/util/groupByOrganization"
import type {
	ApartmentListing,
	ArchivedApartmentListing,
	Organization,
	StoredApartmentListing,
	StoredApartmentListingAccessibility,
} from "../../types"
import type ListingRepository from "./ListingRepository"
import {
	BACKFILL_FIELD_PATHS,
	type KnownBackfillFields,
} from "./ListingRepository"

const LIVENESS_CHECK_PER_ORG_CONCURRENCY = 4

// Storage writes a BSON Double in place of `number`, but the field still
// reads back as `number` everywhere else (Mongo/JS blur the two) - so a
// single cast lives here, once, instead of at every call site below.
function toDouble<T extends number | null | undefined>(value: T): T {
	return (value == null ? value : new Double(value)) as T
}

// Storage shape diverges from in-memory scraper shape only here:
// missing accessibility flags written as `null`
type NormalizedApartmentListing = Omit<ApartmentListing, "accessibility"> & {
	accessibility: StoredApartmentListingAccessibility
}

// Ensures numeric fields are always written as BSON double (never int32),
// regardless of what shape the scraper produced them in.
function normalizeForStorage(
	listing: ApartmentListing,
): NormalizedApartmentListing {
	return {
		...listing,
		spaceQm: toDouble(listing.spaceQm),
		rooms: toDouble(listing.rooms),
		location: {
			...listing.location,
			coordinates: listing.location.coordinates
				? {
						lat: toDouble(listing.location.coordinates.lat),
						lng: toDouble(listing.location.coordinates.lng),
					}
				: listing.location.coordinates,
		},
		costs: {
			...listing.costs,
			coldRentEur: toDouble(listing.costs.coldRentEur),
			utilityEur: toDouble(listing.costs.utilityEur),
			heatingEur: toDouble(listing.costs.heatingEur),
			totalRentEur: toDouble(listing.costs.totalRentEur),
			depositEur: toDouble(listing.costs.depositEur),
		},
		restrictions: listing.restrictions,
		accessibility: {
			senior: listing.accessibility?.senior,
			wheelchair: listing.accessibility?.wheelchair ?? null,
			barrierFree: listing.accessibility?.barrierFree,
		},
		images: listing.images,
	}
}

// $set on nested-object key (e.g. `costs: {...}`) replaces whole
// subdocument rather than merging per field. Flattening costs/location/
// accessibility into dot-notation keys makes every leaf set independently
// instead.
function flattenLeaves(
	value: object,
	prefix: string,
	target: Record<string, unknown>,
): void {
	for (const [key, leaf] of Object.entries(value)) {
		const path = `${prefix}.${key}`
		if (leaf !== null && typeof leaf === "object" && !Array.isArray(leaf)) {
			flattenLeaves(leaf as Record<string, unknown>, path, target)
		} else {
			target[path] = leaf
		}
	}
}

function toSetDocument(
	normalized: NormalizedApartmentListing,
): Record<string, unknown> {
	const { location, costs, accessibility, ...rest } = normalized
	const set: Record<string, unknown> = { ...rest }
	flattenLeaves(location, "location", set)
	flattenLeaves(costs, "costs", set)
	flattenLeaves(accessibility, "accessibility", set)
	return set
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
					$set: toSetDocument(normalized),
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
				const value = dlv(doc, path)
				if (value !== undefined) {
					dset(fields, path, value)
				}
			}
			result.set(doc.listingId, fields)
		}
		return result
	}

	async updateListings(
		listings: ApartmentListing[],
		scrapedOrganizations: Organization[],
		onLivenessProgress?: (checked: number, total: number) => void,
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
		//
		// Checks run bounded-concurrent per organization -> all orgs checked
		// in parallel; a failure on one listing is isolated so it can't stall
		// the rest or abort the run (see pruneDeadAggregatorOnlyListings for
		// the same pattern).
		const docsToArchive: StoredApartmentListing[] = []
		let checked = 0
		const orgGroups = groupByOrganization(untouchedDocs)
		await Promise.all(
			Array.from(orgGroups.values()).map((group) =>
				runConcurrent(
					group,
					LIVENESS_CHECK_PER_ORG_CONCURRENCY,
					async (doc) => {
						try {
							log.info(
								`Checking liveness of ${doc.propertyId} before archiving...`,
							)
							const liveness = await checkListingLiveness(doc)
							if (liveness !== "active") {
								log.info(" -> Yup, it's dead and can be archived.")
								docsToArchive.push(doc)
							}
						} catch (err) {
							log.error(
								`Failed to check liveness of ${doc.organization} ` +
									`listing ${doc.propertyId}: ${err}`,
							)
						} finally {
							checked++
							onLivenessProgress?.(checked, untouchedDocs.length)
						}
					},
				),
			),
		)

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
