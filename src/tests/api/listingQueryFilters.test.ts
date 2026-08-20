import { describe, expect, test } from "bun:test"
import type { ListingQueryFilters } from "../../db/repository/ListingRepository"
import { buildMongoFilter } from "../../db/repository/listingQueryFilters"

describe("buildMongoFilter", () => {
	test("empty filters produce an empty match object", () => {
		const filter = buildMongoFilter({})

		expect(filter).toEqual({})
	})

	test("price range maps to costs.totalRentEur $gte/$lte", () => {
		const filter = buildMongoFilter({ minPrice: 500, maxPrice: 1200 })

		expect(filter).toEqual({ "costs.totalRentEur": { $gte: 500, $lte: 1200 } })
	})

	test("only minPrice sets only $gte", () => {
		const filter = buildMongoFilter({ minPrice: 500 })

		expect(filter).toEqual({ "costs.totalRentEur": { $gte: 500 } })
	})

	test("rooms range maps to rooms $gte/$lte", () => {
		const filter = buildMongoFilter({ minRooms: 2, maxRooms: 4 })

		expect(filter).toEqual({ rooms: { $gte: 2, $lte: 4 } })
	})

	test("space range maps to spaceQm $gte/$lte", () => {
		const filter = buildMongoFilter({ minSpace: 40, maxSpace: 80 })

		expect(filter).toEqual({ spaceQm: { $gte: 40, $lte: 80 } })
	})

	test("organization maps to $in", () => {
		const filter = buildMongoFilter({ organization: ["WBM", "HOWOGE"] })

		expect(filter).toEqual({ organization: { $in: ["WBM", "HOWOGE"] } })
	})

	test("restrictionKind maps to restrictions.kind $in", () => {
		const filter = buildMongoFilter({ restrictionKind: ["free"] })

		expect(filter).toEqual({ "restrictions.kind": { $in: ["free"] } })
	})

	test("wbsLevel maps to restrictions.wbsLevels $in", () => {
		const filter = buildMongoFilter({ wbsLevel: [100, 140] })

		expect(filter).toEqual({ "restrictions.wbsLevels": { $in: [100, 140] } })
	})

	test("boolean filters map to exact-match accessibility/newBuilding fields", () => {
		const filter = buildMongoFilter({
			wheelchair: true,
			barrierFree: false,
			senior: true,
			newBuilding: false,
		})

		expect(filter).toEqual({
			"accessibility.wheelchair": true,
			"accessibility.barrierFree": false,
			"accessibility.senior": true,
			newBuilding: false,
		})
	})

	test("absent fields produce no key at all, not an undefined-valued key", () => {
		const filters: ListingQueryFilters = { minPrice: undefined }
		const filter = buildMongoFilter(filters)

		expect(Object.keys(filter)).toHaveLength(0)
		expect("costs.totalRentEur" in filter).toBe(false)
	})

	test("geo field is ignored by the filter builder (handled separately by $geoNear)", () => {
		const filter = buildMongoFilter({
			geo: { lat: 52.5, lng: 13.4, radiusKm: 5 },
		})

		expect(filter).toEqual({})
	})
})
