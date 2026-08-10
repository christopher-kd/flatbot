import type { SpecialNeed, WBSLevel } from "../../types/wbs"

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

type IncomeRestriction = { wbsLevels: WBSLevel[] }

export type Restrictions =
	| { kind: "free" }
	| ({ kind: "income-checked" } & IncomeRestriction)
	| ({ kind: "wbs-required"; wbsSpecialNeed: SpecialNeed } & IncomeRestriction)

export interface ApartmentListingAccessibility {
	senior?: boolean | null
	wheelchair?: boolean
	barrierFree?: boolean | null
}

export interface ApartmentListingCosts {
	coldRentEur?: number | null
	utilityEur?: number | null
	heatingEur?: number | null
	totalRentEur?: number | null
	depositEur?: number | null
}

export interface ApartmentListingLocation {
	// Optional: degewo's site never exposes postal code
	postalCode?: string
	city: string
	street: string
	houseNumber: string
	neighborhood?: string
	coordinates?: ApartmentListingLocationCoordinates | null
}

export interface ApartmentListingLocationCoordinates {
	type: "Point"
	coordinates: [lng: number, lat: number]
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
	spaceQm?: number | null
	rooms: number
	newBuilding?: boolean | null
	accessibility?: ApartmentListingAccessibility
	// null for Vonovia/Deutsche Wohnen, which skip restrictionFromTitle() —
	// genuinely unclassified
	restrictions: Restrictions | null
	costs: ApartmentListingCosts
	images: ApartmentListingImage[]
	features?: string[]
}

export interface StoredApartmentListingAccessibility {
	senior?: boolean | null
	wheelchair: boolean | null
	barrierFree?: boolean | null
}

// Storage-only bookkeeping fields no scraper ever produces — the repository
// layer is solely responsible for stamping these on write.
export interface StoredApartmentListing
	extends Omit<ApartmentListing, "accessibility"> {
	listingId: string
	firstSeenAt: number
	accessibility: StoredApartmentListingAccessibility
}

export interface ArchivedApartmentListing extends StoredApartmentListing {
	archivedAt: number
}
