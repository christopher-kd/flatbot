import type {
	ApartmentListing,
	ApartmentListingAccessibility,
	ApartmentListingCosts,
	ApartmentListingLocation,
	Organization,
	StoredApartmentListing,
} from "../../types"

export interface KnownBackfillFields {
	spaceQm?: number
	newBuilding?: boolean
	location?: Pick<ApartmentListingLocation, "coordinates">
	costs?: Pick<
		ApartmentListingCosts,
		"depositEur" | "heatingEur" | "coldRentEur" | "utilityEur" | "totalRentEur"
	>
	features?: string[]
	accessibility?: Pick<ApartmentListingAccessibility, "barrierFree" | "senior">
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
	"features",
	"accessibility.senior",
	"accessibility.barrierFree",
] as const

export interface ListingQueryFilters {
	minPrice?: number
	maxPrice?: number
	minRooms?: number
	maxRooms?: number
	minSpace?: number
	maxSpace?: number
	organization?: string[]
	restrictionKind?: string[]
	wbsLevel?: number[]
	wheelchair?: boolean
	barrierFree?: boolean
	senior?: boolean
	newBuilding?: boolean
	geo?: { lat: number; lng: number; radiusKm: number }
}

// mongoPath is trusted, already-resolved - API layer maps user sort keys to
// real paths via MONGO_SORT_FIELDS (api/listings/schema.ts) before calling in.
export type ListingQuerySort =
	| { kind: "field"; mongoPath: string; direction: "asc" | "desc" }
	| { kind: "distance"; direction: "asc" | "desc" }

export interface ListingQueryResultItem {
	listing: StoredApartmentListing
	distanceKm?: number
}

export interface ListingQueryResult {
	items: ListingQueryResultItem[]
	total: number
}

export default interface ListingRepository {
	updateListings(
		listings: ApartmentListing[],
		scrapedOrganizations: Organization[],
		onLivenessProgress?: (checked: number, total: number) => void,
	): Promise<void>

	findKnownBackfillFields(
		listingIds: string[],
	): Promise<Map<string, KnownBackfillFields>>

	queryListings(
		filters: ListingQueryFilters,
		sort: ListingQuerySort | undefined,
		limit: number,
		offset: number,
	): Promise<ListingQueryResult>

	findByListingId(listingId: string): Promise<StoredApartmentListing | null>
}
