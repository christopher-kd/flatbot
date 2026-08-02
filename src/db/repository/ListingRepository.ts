import type {
	ApartmentListing,
	ApartmentListingCosts,
	ApartmentListingLocation,
	Organization,
} from "../../types"

export interface KnownBackfillFields {
	spaceQm?: number
	newBuilding?: boolean
	location?: Pick<ApartmentListingLocation, "coordinates">
	costs?: Pick<
		ApartmentListingCosts,
		"depositEur" | "heatingEur" | "coldRentEur" | "utilityEur" | "totalRentEur"
  >,
	features?: string[]
}

// Single source of truth for which dot-paths are "backfillable" - drives both
// the DB read (MongoListingRepository.findKnownBackfillFields, generically
// plucked instead of hand-listed per field) and, implicitly, the shape of
// KnownBackfillFields above. Adding a new backfillable field only needs a new
// entry here plus a corresponding optional field on the interface.
export const BACKFILL_FIELD_PATHS = [
	"spaceQm",
	"newBuilding",
	"location.coordinates",
	"costs.depositEur",
	"costs.heatingEur",
	"costs.coldRentEur",
	"costs.utilityEur",
  "costs.totalRentEur",
	"features"
] as const

export default interface ListingRepository {
	updateListings(
		listings: ApartmentListing[],
		scrapedOrganizations: Organization[],
	): Promise<void>

	findKnownBackfillFields(
		listingIds: string[],
	): Promise<Map<string, KnownBackfillFields>>
}
