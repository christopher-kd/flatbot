import type ListingRepository from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type { ApartmentListing, ApartmentListingLocation } from "../types"
import type PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import { runConcurrent } from "./util/concurrency"
import { fillMissing } from "./util/fillMissing"

const COORDINATE_FETCH_CONCURRENCY = 6

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

// Runs each scraper's backfill() hook against its slice of listings,
// isolated so one landlord failing doesn't affect the rest.
export async function runScraperBackfills(
	directScrapers: Scraper[],
	listings: ApartmentListing[],
): Promise<void> {
	for (const scraper of directScrapers) {
		const orgListings = listings.filter(
			(l) => l.organization === scraper.organization,
		)
		try {
			await scraper.backfill(orgListings)
		} catch (err) {
			log.error(`${scraper.organization} backfill failed: ${err}`)
		}
	}
}

// Fills missing coordinates via Photon, bounded-concurrent and isolated
// per-listing so one unresolvable address can't abort the whole run.
export async function fillMissingCoordinates(
	photonClient: PhotonClient,
	listings: ApartmentListing[],
	addressFor: (location: ApartmentListingLocation) => string,
): Promise<void> {
	const targets = listings.filter((l) => !l.location.coordinates)
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
			}
		},
	)
}
