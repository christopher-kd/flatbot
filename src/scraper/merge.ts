import type {
	ApartmentListing,
	ApartmentListingCosts,
	ApartmentListingImage,
	ApartmentListingLocation,
	Restrictions,
	WBSLevel,
} from "../types"
import type { ScraperRunResult } from "./ScraperRunner.types"
import { required } from "./util/assert"

function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined
}

function pick<T>(
	preferred: T | undefined,
	fallback: T | undefined,
): T | undefined {
	return isDefined(preferred) ? preferred : fallback
}

// Recursively counts non-null/undefined leaves - decides which duplicate
// listing is "preferred". 0/false/"" count as defined, only null/undefined
// don't.
export function countDefinedFields(value: unknown): number {
	if (value === null || value === undefined) return 0
	if (Array.isArray(value)) {
		return value.reduce((sum: number, v) => sum + countDefinedFields(v), 0)
	}
	if (typeof value === "object") {
		return Object.values(value).reduce(
			(sum: number, v) => sum + countDefinedFields(v),
			0,
		)
	}
	return 1
}

// Images are purely additive, so union by URL instead of picking one side.
function mergeImages(
	preferred: ApartmentListingImage[] | undefined,
	fallback: ApartmentListingImage[] | undefined,
): ApartmentListingImage[] {
	const byUrl = new Map(
		(preferred ?? []).map((image) => [image.fullUrl, image] as const),
	)
	for (const image of fallback ?? []) {
		if (!byUrl.has(image.fullUrl)) byUrl.set(image.fullUrl, image)
	}
	return [...byUrl.values()]
}

// Typed as required, but adapters don't always deliver at runtime (e.g.
// Berlinovo ships `location: null`) - guard before touching fields.
function mergeLocation(
	preferred: ApartmentListingLocation,
	fallback: ApartmentListingLocation,
): ApartmentListingLocation {
	if (!preferred) return fallback
	if (!fallback) return preferred
	return {
		postalCode: preferred.postalCode ?? fallback.postalCode,
		city: preferred.city ?? fallback.city,
		street: preferred.street ?? fallback.street,
		houseNumber: preferred.houseNumber ?? fallback.houseNumber,
		neighborhood: pick(preferred.neighborhood, fallback.neighborhood),
		coordinates: pick(preferred.coordinates, fallback.coordinates),
	}
}

function mergeCosts(
	preferred: ApartmentListingCosts,
	fallback: ApartmentListingCosts,
): ApartmentListingCosts {
	if (!preferred) return fallback
	if (!fallback) return preferred
	return {
		coldRentEur: pick(preferred.coldRentEur, fallback.coldRentEur),
		utilityEur: pick(preferred.utilityEur, fallback.utilityEur),
		heatingEur: pick(preferred.heatingEur, fallback.heatingEur),
		totalRentEur: pick(preferred.totalRentEur, fallback.totalRentEur),
		depositEur: pick(preferred.depositEur, fallback.depositEur),
	}
}

// Discrete facts, not conflicting values - union is strictly more complete.
function mergeWbsLevels(
	preferred?: WBSLevel[],
	fallback?: WBSLevel[],
): WBSLevel[] | undefined {
	if (!preferred?.length && !fallback?.length) return undefined
	return [...new Set([...(preferred ?? []), ...(fallback ?? [])])].sort(
		(a, b) => a - b,
	)
}

// Merge when both sides agree on `kind`, otherwise trust `preferred`
// wholesale. Either side can be null.
function mergeRestrictions(
	preferred: Restrictions | null,
	fallback: Restrictions | null,
): Restrictions | null {
	if (!preferred) return fallback
	if (!fallback) return preferred
	if (preferred.kind !== fallback.kind) return preferred
	if (preferred.kind === "free") return preferred
	// `fallback` provably shares `kind` with `preferred` per the check above,
	// but TS can't correlate that across two separate variables - cast once.
	const matchedFallback = fallback as Exclude<Restrictions, { kind: "free" }>
	const wbsLevels =
		mergeWbsLevels(preferred.wbsLevels, matchedFallback.wbsLevels) ?? []
	if (preferred.kind === "income-checked")
		return { kind: "income-checked", wbsLevels }
	return {
		kind: "wbs-required",
		wbsLevels,
		wbsSpecialNeed:
			pick(
				preferred.wbsSpecialNeed,
				(matchedFallback as Extract<Restrictions, { kind: "wbs-required" }>)
					.wbsSpecialNeed,
			) ?? null,
	}
}

// Aggregator fills fields direct doesn't have
function mergeApartmentListings(
	direct: ApartmentListing,
	aggregator: ApartmentListing,
): ApartmentListing {
	return {
		propertyId: direct.propertyId,
		listingId: direct.listingId,
		organization: direct.organization,
		lastSeenAt: Math.max(direct.lastSeenAt, aggregator.lastSeenAt),
		title: direct.title ?? aggregator.title,
		fullUrl: direct.fullUrl,
		location: mergeLocation(direct.location, aggregator.location),
		spaceQm: pick(direct.spaceQm, aggregator.spaceQm),
		// `rooms` required on every listing
		rooms: direct.rooms,
		newBuilding: pick(direct.newBuilding, aggregator.newBuilding),
		accessibility: pick(direct.accessibility, aggregator.accessibility),
		restrictions: mergeRestrictions(
			direct.restrictions,
			aggregator.restrictions,
		),
		costs: mergeCosts(direct.costs, aggregator.costs),
		images: mergeImages(direct.images, aggregator.images),
	}
}

// Merge direct with aggregator listings, property-by-property.
export function mergeAggregatorListings(
	direct: ApartmentListing[],
	aggregator: ApartmentListing[],
): ApartmentListing[] {
	// listingId always populated by Scraper.fetchListings().
	// required() asserts that invariant, not a runtime guess.
	const byListingId = new Map(
		direct.map((listing) => [
			required(listing.listingId, "listing.listingId"),
			listing,
		]),
	)
	for (const listing of aggregator) {
		const listingId = required(listing.listingId, "listing.listingId")
		const existing = byListingId.get(listingId)
		byListingId.set(
			listingId,
			existing ? mergeApartmentListings(existing, listing) : listing,
		)
	}
	return [...byListingId.values()]
}

// Flatten direct scraper results into one listings array, merge in the
// aggregator's listings, and derives the `directListingIds` set needed
// afterward to tell aggregator-only listings apart for the liveness prune.
export function mergeDirectAndAggregatorListings(
	directResults: ScraperRunResult[],
	aggregatorListings: ApartmentListing[],
): { merged: ApartmentListing[]; directListingIds: Set<string> } {
	const directListings = directResults.flatMap((r) => r.listings)
	const merged = mergeAggregatorListings(directListings, aggregatorListings)
	const directListingIds = new Set(
		directListings
			.map((l) => l.listingId)
			.filter((id): id is string => id !== undefined),
	)
	return { merged, directListingIds }
}
