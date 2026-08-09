import { describe, expect, test } from "bun:test"
import { mergeAggregatorListings } from "../scraper/merge"
import type { ApartmentListing } from "../types"

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		listingId: "WBM:1",
		propertyId: "1",
		organization: "WBM",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://example.com/1",
		location: {
			postalCode: "12345",
			city: "Berlin",
			street: "Teststr.",
			houseNumber: "1",
		},
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: {},
		images: [],
		...overrides,
	}
}

describe("mergeAggregatorListings - costs tri-state", () => {
	test("direct undefined, aggregator has value - aggregator fills the gap", () => {
		const direct = makeListing({ costs: { coldRentEur: undefined } })
		const aggregator = makeListing({ costs: { coldRentEur: 500 } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.costs.coldRentEur).toBe(500)
	})

	test("direct has a value, aggregator has a different value - direct wins", () => {
		const direct = makeListing({ costs: { coldRentEur: 500 } })
		const aggregator = makeListing({ costs: { coldRentEur: 999 } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.costs.coldRentEur).toBe(500)
	})

	test("direct is null (confirmed absent), aggregator has value - aggregator wins", () => {
		const direct = makeListing({ costs: { coldRentEur: null } })
		const aggregator = makeListing({ costs: { coldRentEur: 500 } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.costs.coldRentEur).toBe(500)
	})

	test("both undefined - stays undefined, not coerced to null", () => {
		const direct = makeListing({ costs: { coldRentEur: undefined } })
		const aggregator = makeListing({ costs: { coldRentEur: undefined } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.costs.coldRentEur).toBeUndefined()
	})

	test("no aggregator match for this listingId - direct's own costs untouched", () => {
		const direct = makeListing({
			listingId: "WBM:1",
			costs: { coldRentEur: 500 },
		})
		const aggregator = makeListing({
			listingId: "WBM:2",
			costs: { coldRentEur: 999 },
		})

		const merged = mergeAggregatorListings([direct], [aggregator])

		expect(merged).toHaveLength(2)
		const own = merged.find((l) => l.listingId === "WBM:1")
		expect(own?.costs.coldRentEur).toBe(500)
	})

	test("each cost field merges independently, not as one all-or-nothing object", () => {
		const direct = makeListing({
			costs: { coldRentEur: 500, utilityEur: undefined },
		})
		const aggregator = makeListing({
			costs: { coldRentEur: 999, utilityEur: 100 },
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.costs.coldRentEur).toBe(500)
		expect(merged.costs.utilityEur).toBe(100)
	})
})

describe("mergeAggregatorListings - accessibility tri-state", () => {
	test("direct undefined, aggregator has value - aggregator fills the gap", () => {
		const direct = makeListing({ accessibility: { senior: undefined } })
		const aggregator = makeListing({ accessibility: { senior: true } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.accessibility?.senior).toBe(true)
	})

	test("direct has a value, aggregator has a different value - direct wins", () => {
		const direct = makeListing({ accessibility: { senior: false } })
		const aggregator = makeListing({ accessibility: { senior: true } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.accessibility?.senior).toBe(false)
	})

	test("direct is null (confirmed absent), aggregator has value - aggregator wins", () => {
		const direct = makeListing({ accessibility: { senior: null } })
		const aggregator = makeListing({ accessibility: { senior: true } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.accessibility?.senior).toBe(true)
	})

	test("both undefined - stays undefined, not coerced to null", () => {
		const direct = makeListing({ accessibility: { senior: undefined } })
		const aggregator = makeListing({ accessibility: { senior: undefined } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.accessibility?.senior).toBeUndefined()
	})

	test("each field merges independently - direct's wheelchair survives aggregator filling senior", () => {
		const direct = makeListing({
			accessibility: { wheelchair: true, senior: undefined },
		})
		const aggregator = makeListing({
			accessibility: { wheelchair: false, senior: true },
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.accessibility?.wheelchair).toBe(true)
		expect(merged.accessibility?.senior).toBe(true)
	})
})

describe("mergeAggregatorListings - location.coordinates tri-state", () => {
	test("direct undefined, aggregator has value - aggregator fills the gap", () => {
		const direct = makeListing({ location: { ...makeListing().location } })
		const aggregator = makeListing({
			location: {
				...makeListing().location,
				coordinates: { lat: 52.5, lng: 13.4 },
			},
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.location.coordinates).toEqual({ lat: 52.5, lng: 13.4 })
	})

	test("direct has a value, aggregator has a different value - direct wins", () => {
		const direct = makeListing({
			location: {
				...makeListing().location,
				coordinates: { lat: 52.1, lng: 13.1 },
			},
		})
		const aggregator = makeListing({
			location: {
				...makeListing().location,
				coordinates: { lat: 52.9, lng: 13.9 },
			},
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.location.coordinates).toEqual({ lat: 52.1, lng: 13.1 })
	})

	test("direct is null (confirmed unresolvable), aggregator has value - aggregator wins", () => {
		const direct = makeListing({
			location: { ...makeListing().location, coordinates: null },
		})
		const aggregator = makeListing({
			location: {
				...makeListing().location,
				coordinates: { lat: 52.5, lng: 13.4 },
			},
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.location.coordinates).toEqual({ lat: 52.5, lng: 13.4 })
	})

	test("both undefined - stays undefined, not coerced to null", () => {
		const direct = makeListing({ location: { ...makeListing().location } })
		const aggregator = makeListing({ location: { ...makeListing().location } })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.location.coordinates).toBeUndefined()
	})

	test("direct's own street/postalCode survives even when aggregator fills coordinates", () => {
		const direct = makeListing({
			location: { ...makeListing().location, street: "Direktstr." },
		})
		const aggregator = makeListing({
			location: {
				...makeListing().location,
				street: "Aggregatorstr.",
				coordinates: { lat: 52.5, lng: 13.4 },
			},
		})

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.location.street).toBe("Direktstr.")
		expect(merged.location.coordinates).toEqual({ lat: 52.5, lng: 13.4 })
	})
})

describe("mergeAggregatorListings - features", () => {
	test("direct undefined, aggregator has value - aggregator fills the gap", () => {
		const direct = makeListing({ features: undefined })
		const aggregator = makeListing({ features: ["Balkon"] })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.features).toEqual(["Balkon"])
	})

	test("direct has a value, aggregator has a different value - direct wins", () => {
		const direct = makeListing({ features: ["Aufzug"] })
		const aggregator = makeListing({ features: ["Balkon"] })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.features).toEqual(["Aufzug"])
	})

	test("direct has an empty array (confirmed none) - direct's empty array wins over aggregator", () => {
		const direct = makeListing({ features: [] })
		const aggregator = makeListing({ features: ["Balkon"] })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.features).toEqual([])
	})

	test("both undefined - stays undefined, not silently dropped", () => {
		const direct = makeListing({ features: undefined })
		const aggregator = makeListing({ features: undefined })

		const [merged] = mergeAggregatorListings([direct], [aggregator])

		expect(merged.features).toBeUndefined()
	})
})
