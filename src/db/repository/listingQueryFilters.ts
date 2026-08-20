import type { ListingQueryFilters } from "./ListingRepository"

// Loose Record instead of mongodb.Filter<StoredApartmentListing> - dot-paths
// like "restrictions.wbsLevels" don't type-check against Filter<T> since
// restrictions is a union type. Same workaround as MongoListingRepository's
// toSetDocument.
export function buildMongoFilter(
	filters: ListingQueryFilters,
): Record<string, unknown> {
	const match: Record<string, unknown> = {}

	const price: Record<string, number> = {}
	if (filters.minPrice !== undefined) price.$gte = filters.minPrice
	if (filters.maxPrice !== undefined) price.$lte = filters.maxPrice
	if (Object.keys(price).length > 0) match["costs.totalRentEur"] = price

	const rooms: Record<string, number> = {}
	if (filters.minRooms !== undefined) rooms.$gte = filters.minRooms
	if (filters.maxRooms !== undefined) rooms.$lte = filters.maxRooms
	if (Object.keys(rooms).length > 0) match.rooms = rooms

	const space: Record<string, number> = {}
	if (filters.minSpace !== undefined) space.$gte = filters.minSpace
	if (filters.maxSpace !== undefined) space.$lte = filters.maxSpace
	if (Object.keys(space).length > 0) match.spaceQm = space

	if (filters.organization !== undefined && filters.organization.length > 0) {
		match.organization = { $in: filters.organization }
	}

	if (
		filters.restrictionKind !== undefined &&
		filters.restrictionKind.length > 0
	) {
		match["restrictions.kind"] = { $in: filters.restrictionKind }
	}

	if (filters.wbsLevel !== undefined && filters.wbsLevel.length > 0) {
		match["restrictions.wbsLevels"] = { $in: filters.wbsLevel }
	}

	if (filters.wheelchair !== undefined) {
		match["accessibility.wheelchair"] = filters.wheelchair
	}

	if (filters.barrierFree !== undefined) {
		match["accessibility.barrierFree"] = filters.barrierFree
	}

	if (filters.senior !== undefined) {
		match["accessibility.senior"] = filters.senior
	}

	if (filters.newBuilding !== undefined) {
		match.newBuilding = filters.newBuilding
	}

	return match
}
