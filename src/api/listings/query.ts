import type { z } from "zod"
import type {
	ListingQueryFilters,
	ListingQuerySort,
} from "../../db/repository/ListingRepository"
import { type listingsQuerySchema, MONGO_SORT_FIELDS } from "./schema"

type ListingsQuery = z.infer<typeof listingsQuerySchema>

export function toRepositoryFilters(query: ListingsQuery): ListingQueryFilters {
	return {
		minPrice: query.minPrice,
		maxPrice: query.maxPrice,
		minRooms: query.minRooms,
		maxRooms: query.maxRooms,
		minSpace: query.minSpace,
		maxSpace: query.maxSpace,
		organization:
			query.organization.length > 0 ? query.organization : undefined,
		restrictionKind:
			query.restrictionKind.length > 0 ? query.restrictionKind : undefined,
		wbsLevel: query.wbsLevel.length > 0 ? query.wbsLevel : undefined,
		wheelchair: query.wheelchair,
		barrierFree: query.barrierFree,
		senior: query.senior,
		newBuilding: query.newBuilding,
		geo:
			query.lat !== undefined &&
			query.lng !== undefined &&
			query.radiusKm !== undefined
				? { lat: query.lat, lng: query.lng, radiusKm: query.radiusKm }
				: undefined,
	}
}

export function toRepositorySort(
	sort: string | undefined,
): ListingQuerySort | undefined {
	if (!sort) return undefined

	const [field, dir] = sort.split(":")
	const direction = dir === "desc" ? "desc" : "asc"

	if (field === "distance") {
		return { kind: "distance", direction }
	}

	const mongoPath = MONGO_SORT_FIELDS[field as keyof typeof MONGO_SORT_FIELDS]
	return { kind: "field", mongoPath, direction }
}
