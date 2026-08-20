import type { Restriction, StoredApartmentListing } from "../types"

export const RESTRICTION_KINDS = [
	"free",
	"income-checked",
	"wbs-required",
] as const satisfies readonly Restriction[]

export type RestrictionKind = Restriction

export type Listing = StoredApartmentListing

export type ListingSummary = Pick<
	StoredApartmentListing,
	| "listingId"
	| "organization"
	| "title"
	| "rooms"
	| "spaceQm"
	| "costs"
	| "restrictions"
	| "images"
	| "fullUrl"
> & {
	location: Pick<StoredApartmentListing["location"], "city" | "neighborhood">
	distanceKm?: number
}

export interface ListingsResponse {
	total: number
	limit: number
	offset: number
	items: ListingSummary[]
}

export function toListingSummary(
	listing: StoredApartmentListing,
	distanceKm?: number,
): ListingSummary {
	return {
		listingId: listing.listingId,
		organization: listing.organization,
		title: listing.title,
		rooms: listing.rooms,
		spaceQm: listing.spaceQm,
		costs: listing.costs,
		restrictions: listing.restrictions,
		images: listing.images,
		fullUrl: listing.fullUrl,
		location: {
			city: listing.location.city,
			neighborhood: listing.location.neighborhood,
		},
		...(distanceKm !== undefined ? { distanceKm } : {}),
	}
}
