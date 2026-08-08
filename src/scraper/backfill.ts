import type ListingRepository from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type { ApartmentListing, ApartmentListingLocation } from "../types"
import { checkListingLiveness } from "./liveness"
import type PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import { runConcurrent } from "./util/concurrency"
import { fillMissing } from "./util/fillMissing"
import { groupByOrganization } from "./util/groupByOrganization"

const COORDINATE_FETCH_CONCURRENCY = 6
const AGGREGATOR_LIVENESS_PER_ORG_CONCURRENCY = 4

// Hydrates DB-known fields onto fresh listings so backfills below can skip
// work they'd otherwise redo every run.
export async function hydrateKnownBackfillFields(
	listingRepository: ListingRepository,
	listings: ApartmentListing[],
): Promise<void> {
	const listingIds = listings
		.map((l) => l.listingId)
		.filter((id): id is string => id !== undefined)
	if (listingIds.length === 0) return

	let known: Awaited<ReturnType<ListingRepository["findKnownBackfillFields"]>>
	try {
		known = await listingRepository.findKnownBackfillFields(listingIds)
	} catch (err) {
		// Degrade to re-backfilling everything this run rather than aborting.
		log.error(`Failed to hydrate known backfill fields from DB: ${err}`)
		return
	}

	for (const listing of listings) {
		if (!listing.listingId) continue
		const knownFields = known.get(listing.listingId)
		if (!knownFields) continue
		fillMissing(listing, knownFields)
	}
}

// Runs one scraper's backfill() hook against its slice of listings.
// Returns if success, doesn't throw
export async function backfillOneOrg(
	scraper: Scraper,
	listings: ApartmentListing[],
): Promise<boolean> {
	const orgListings = listings.filter(
		(l) => l.organization === scraper.organization,
	)
	try {
		await scraper.backfill(orgListings)
		return true
	} catch (err) {
		log.error(`${scraper.organization} backfill failed: ${err}`)
		return false
	}
}

// Runs each scraper's backfill() hook sequentially
export async function runScraperBackfills(
	directScrapers: Scraper[],
	listings: ApartmentListing[],
): Promise<void> {
	for (const scraper of directScrapers) {
		await backfillOneOrg(scraper, listings)
	}
}

// Fills missing coordinates via Photon, bounded-concurrent and isolated
// per-listing so one unresolvable address can't abort the whole run.
export async function fillMissingCoordinates(
	photonClient: PhotonClient,
	listings: ApartmentListing[],
	addressFor: (location: ApartmentListingLocation) => string,
	onProgress?: (checked: number, total: number) => void,
): Promise<void> {
	const targets = listings.filter((l) => l.location.coordinates === undefined)
	let checked = 0
	await runConcurrent(
		targets,
		COORDINATE_FETCH_CONCURRENCY,
		async (listing) => {
			try {
				listing.location.coordinates = await photonClient.fetchCoordinates(
					addressFor(listing.location),
				)
			} catch (err) {
				log.error(
					`Failed to fetch coordinates for ${listing.organization} ` +
						`listing ${listing.propertyId}: ${err}`,
				)
			} finally {
				checked++
				onProgress?.(checked, targets.length)
			}
		},
	)
}

async function checkAndTrackLiveness(
	listing: ApartmentListing,
	deadListingIds: Set<string>,
	progress: { checked: number; total: number },
	onProgress?: (checked: number, total: number) => void,
): Promise<void> {
	try {
		const liveness = await checkListingLiveness(listing)
		if (liveness === "inactive" && listing.listingId) {
			deadListingIds.add(listing.listingId)
    }
	} catch (err) {
		log.error(
			`Failed to check liveness of aggregator-only listing ` +
				`${listing.organization} ${listing.propertyId}: ${err}`,
		)
	} finally {
		progress.checked++
		onProgress?.(progress.checked, progress.total)
	}
}

// Checks run bounded-concurrent per organization -> all orgs checked
// in parallel.
export async function pruneDeadAggregatorOnlyListings(
	listings: ApartmentListing[],
	directListingIds: Set<string>,
	onProgress?: (checked: number, total: number) => void,
): Promise<ApartmentListing[]> {
	const aggregatorOnly = listings.filter(
		(l) => l.listingId && !directListingIds.has(l.listingId),
	)
	const orgGroups = groupByOrganization(aggregatorOnly)

	const deadListingIds = new Set<string>()
	const progress = { checked: 0, total: aggregatorOnly.length }
	await Promise.all(
		Array.from(orgGroups.values()).map((group) =>
			runConcurrent(
				group,
				AGGREGATOR_LIVENESS_PER_ORG_CONCURRENCY,
				(listing) =>
					checkAndTrackLiveness(listing, deadListingIds, progress, onProgress),
			),
		),
	)

	return listings.filter((l) => !l.listingId || !deadListingIds.has(l.listingId))
}
