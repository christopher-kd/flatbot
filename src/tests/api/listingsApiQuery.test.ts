import { describe, expect, test } from "bun:test"
import { toRepositoryFilters, toRepositorySort } from "../../api/listings/query"
import { listingsQuerySchema } from "../../api/listings/schema"

function parseQuery(input: Record<string, string | string[]>) {
	return listingsQuerySchema.parse(input)
}

describe("toRepositoryFilters", () => {
	test("passes geo through only when lat, lng, and radiusKm are all present", () => {
		const query = parseQuery({ lat: "52.5", lng: "13.4", radiusKm: "5" })

		const filters = toRepositoryFilters(query)

		expect(filters.geo).toEqual({ lat: 52.5, lng: 13.4, radiusKm: 5 })
	})

	test("omits geo when lat/lng/radiusKm are absent", () => {
		const query = parseQuery({})

		const filters = toRepositoryFilters(query)

		expect(filters.geo).toBeUndefined()
	})

	test("converts empty organization/restrictionKind/wbsLevel arrays to undefined", () => {
		const query = parseQuery({})

		const filters = toRepositoryFilters(query)

		expect(filters.organization).toBeUndefined()
		expect(filters.restrictionKind).toBeUndefined()
		expect(filters.wbsLevel).toBeUndefined()
	})

	test("passes through non-empty organization/restrictionKind/wbsLevel arrays", () => {
		const query = parseQuery({
			organization: "WBM,HOWOGE",
			restrictionKind: "free",
			wbsLevel: "100,140",
		})

		const filters = toRepositoryFilters(query)

		expect(filters.organization).toEqual(["WBM", "HOWOGE"])
		expect(filters.restrictionKind).toEqual(["free"])
		expect(filters.wbsLevel).toEqual([100, 140])
	})

	test("passes through boolean and range filters unchanged", () => {
		const query = parseQuery({
			minPrice: "500",
			maxPrice: "1200",
			wheelchair: "true",
			newBuilding: "false",
		})

		const filters = toRepositoryFilters(query)

		expect(filters.minPrice).toBe(500)
		expect(filters.maxPrice).toBe(1200)
		expect(filters.wheelchair).toBe(true)
		expect(filters.newBuilding).toBe(false)
	})
})

describe("toRepositorySort", () => {
	test("undefined sort returns undefined", () => {
		expect(toRepositorySort(undefined)).toBeUndefined()
	})

	test("field-only sort defaults to ascending", () => {
		expect(toRepositorySort("rooms")).toEqual({
			kind: "field",
			mongoPath: "rooms",
			direction: "asc",
		})
	})

	test("field:desc resolves the mapped mongo path with descending direction", () => {
		expect(toRepositorySort("totalRentEur:desc")).toEqual({
			kind: "field",
			mongoPath: "costs.totalRentEur",
			direction: "desc",
		})
	})

	test("distance sorts by kind distance, defaulting to ascending", () => {
		expect(toRepositorySort("distance")).toEqual({
			kind: "distance",
			direction: "asc",
		})
	})

	test("distance:desc keeps kind distance with descending direction", () => {
		expect(toRepositorySort("distance:desc")).toEqual({
			kind: "distance",
			direction: "desc",
		})
	})
})
