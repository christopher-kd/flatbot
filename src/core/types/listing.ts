import type { Restriction, SpecialNeed, WBSLevel } from "../../types/wbs"

export type Organization =
	| "Stadt und Land"
	| "HOWOGE"
	| "degewo"
	| "Gewobag"
	| "GESOBAU"
	| "Berlinovo"
	| "WBM"
	| "Vonovia"
	| "Deutsche Wohnen"
	| "inberlinwohnen"

export interface Restrictions {
	kind: Restriction
	wbsLevels?: WBSLevel[]
	wbsSpecialNeed?: SpecialNeed
}

export interface ApartmentListingAccessibility {
	senior?: boolean
	wheelchair?: boolean
	barrierFree?: boolean
}

export interface ApartmentListingCosts {
	coldRentEur?: number
	utilityEur?: number
	heatingEur?: number
	totalRentEur?: number
	depositEur?: number
}

export interface ApartmentListingLocation {
	postalCode: string
	city: string
	street: string
	houseNumber: string
	neighborhood?: string
	coordinates?: ApartmentListingLocationCoordinates
}

export interface ApartmentListingLocationCoordinates {
	lat: number
	lng: number
}

export interface ApartmentListingImage {
	fullUrl: string
	alt?: string
	format?: string
}

export interface ApartmentListing {
	propertyId: string
	// Populated by Scraper.fetchListings() as `${organization}:${propertyId}`,
	// globally unique across orgs, unlike propertyId alone.
	listingId?: string
	organization: Organization
	lastSeenAt: number
	title: string
	fullUrl: string
	location: ApartmentListingLocation
	spaceQm?: number
	rooms: number
	newBuilding?: boolean
	accessibility?: ApartmentListingAccessibility
	restrictions: Restrictions
	costs: ApartmentListingCosts
	images: ApartmentListingImage[]
	features?: string[]
}

// Storage-only bookkeeping fields no scraper ever produces — the repository
// layer is solely responsible for stamping these on write.
export interface StoredApartmentListing extends ApartmentListing {
	listingId: string
	firstSeenAt: number
}

export interface ArchivedApartmentListing extends StoredApartmentListing {
	archivedAt: number
}
