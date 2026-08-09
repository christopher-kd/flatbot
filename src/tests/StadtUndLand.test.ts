import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import StadtUndLand from "../scraper/adapters/StadtUndLand"
import type {
	DistrictData,
	StadtUndLandReponse,
} from "../scraper/adapters/StadtUndLand.types"
import type { ApartmentListing } from "../types"
import apartmentsNew from "./fixtures/stadtundland/apartments-new.json"
import apartmentsPage0 from "./fixtures/stadtundland/apartments-page0.json"
import districts from "./fixtures/stadtundland/districts.json"

const sul = new StadtUndLand()

type Apartment = StadtUndLandReponse["data"][number]

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/stadtundland/${name}`).text()
}

function findApartment(immoNumber: string): Apartment {
	const apt = apartmentsPage0.data.find(
		(a) => a.details.immoNumber === immoNumber,
	)
	if (!apt) throw new Error("fixture apartment not found")
	return apt as Apartment
}

const newBuildingIds = new Set(
	apartmentsNew.data.map((a) => a.details.immoNumber),
)
const subdistrictToDistrict = new Map(
	(districts as DistrictData).flatMap(({ district, subdistrict }) =>
		subdistrict.map((sub) => [sub, district] as const),
	),
)

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "Stadt und Land",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://stadtundland.de/wohnungssuche/1",
		location: {
			postalCode: "12345",
			city: "Berlin",
			street: "Teststr.",
			houseNumber: "1",
		},
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: { totalRentEur: 500 },
		images: [],
		...overrides,
	}
}

describe("StadtUndLand.extractListing", () => {
	test("parses a real new-building apartment, deriving depositEur as coldRentEur x 3", () => {
		const apt = findApartment("1001/5248/00229")

		const listing = sul.extractListing(
			apt,
			newBuildingIds,
			subdistrictToDistrict,
		)

		expect(listing.propertyId).toBe("1001/5248/00229")
		expect(listing.fullUrl).toBe(
			"https://stadtundland.de/wohnungssuche/1001/5248/00229",
		)
		expect(listing.location).toEqual({
			postalCode: "12349",
			city: "Berlin",
			street: "An den Buckower Feldern",
			houseNumber: "13",
			neighborhood: "Neukölln",
		})
		expect(listing.spaceQm).toBe(70.04)
		expect(listing.rooms).toBe(3)
		expect(listing.newBuilding).toBe(true)
		expect(listing.costs).toEqual({
			coldRentEur: 1119.24,
			depositEur: 3357.72,
			utilityEur: 157.59,
			heatingEur: 122.57,
			totalRentEur: 1399.4,
		})
		expect(listing.accessibility).toEqual({
			wheelchair: false,
			senior: false,
			barrierFree: false,
		})
	})

	test("resolves neighborhood from precinct via the districts map", () => {
		const apt = findApartment("1050/8222/00113")

		const listing = sul.extractListing(
			apt,
			newBuildingIds,
			subdistrictToDistrict,
		)

		expect(apt.address.precinct).toBe("Kaulsdorf-Nord II")
		expect(listing.location.neighborhood).toBe("Hellersdorf")
	})

	test("leaves neighborhood undefined for a precinct absent from the districts map", () => {
		const apt = findApartment("1050/8222/00113")

		const listing = sul.extractListing(
			{
				...apt,
				address: { ...apt.address, precinct: "Some Unmapped Precinct" },
			},
			newBuildingIds,
			subdistrictToDistrict,
		)

		expect(listing.location.neighborhood).toBeUndefined()
	})

	test("newBuilding is false when the immoNumber isn't in the new-buildings set", () => {
		const apt = findApartment("1001/6119/00344")

		const listing = sul.extractListing(
			apt,
			newBuildingIds,
			subdistrictToDistrict,
		)

		expect(newBuildingIds.has(apt.details.immoNumber)).toBe(false)
		expect(listing.newBuilding).toBe(false)
	})

	// Real fixture: this apartment's own API response has no
	// wheelchairFriendly/seniorsFriendly keys at all (type reflects this -
	// both are optional). wheelchair isn't tri-state, so it stays undefined
	// as-is; senior IS a tracked backfill field but this adapter never
	// retries it, so a missing key is coerced to null (confirmed absent)
	// rather than a false "will retry next run" promise.
	test("wheelchair stays undefined but senior is coerced to null when absent from the source", () => {
		const apt = findApartment("1050/8222/00113")

		expect(apt.details).not.toHaveProperty("wheelchairFriendly")
		expect(apt.details).not.toHaveProperty("seniorsFriendly")

		const listing = sul.extractListing(
			apt,
			newBuildingIds,
			subdistrictToDistrict,
		)

		expect(listing.accessibility?.wheelchair).toBeUndefined()
		expect(listing.accessibility?.senior).toBeNull()
		expect(listing.accessibility?.barrierFree).toBe(true)
	})
})

describe("StadtUndLand.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("fills features from the detail page's Ausstattung row, split on ', '", async () => {
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeListing({ features: undefined })

		await sul.backfill([target])

		expect(target.features).toEqual([
			"Balkon/Terasse",
			"Keller",
			"Personenaufzug",
			"Badewanne",
		])
	})

	test("skips a listing that already has a features array, even an empty one", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
		const withFeatures = makeListing({ features: ["existing"] })
		const withEmptyFeatures = makeListing({ features: [] })

		await sul.backfill([withFeatures, withEmptyFeatures])

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(withFeatures.features).toEqual(["existing"])
		expect(withEmptyFeatures.features).toEqual([])
	})

	test("one listing's fetch failure doesn't block a sibling's backfill", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			if (href.includes("broken")) throw new Error("network down")
			return new Response(detailHtml)
		}) as unknown as typeof fetch)
		const broken = makeListing({
			propertyId: "broken-id",
			fullUrl: "https://stadtundland.de/wohnungssuche/broken",
			features: undefined,
		})
		const healthy = makeListing({
			propertyId: "healthy-id",
			fullUrl: "https://stadtundland.de/wohnungssuche/healthy",
			features: undefined,
		})

		await sul.backfill([broken, healthy])

		expect(broken.features).toBeUndefined()
		expect(healthy.features).toEqual([
			"Balkon/Terasse",
			"Keller",
			"Personenaufzug",
			"Badewanne",
		])
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})

describe("StadtUndLand.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates the main feed, cross-references the new-building feed, and resolves districts", async () => {
		const apt0 = findApartment("1001/5248/00229") // Buckower Felder -> Neukölln
		const apt1 = findApartment("1050/8222/00113") // Kaulsdorf-Nord II -> Hellersdorf

		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
			init?: RequestInit,
		) => {
			const href = String(url)
			if (href.includes("districts")) {
				return new Response(JSON.stringify(districts))
			}
			const body = JSON.parse(String(init?.body)) as {
				new: boolean
				offset: number
			}
			if (body.new === true) {
				return new Response(
					JSON.stringify({
						data: [apt1],
						count: 1,
					} satisfies StadtUndLandReponse),
				)
			}
			if (body.offset === 0) {
				return new Response(
					JSON.stringify({
						data: [apt0],
						count: 2,
					} satisfies StadtUndLandReponse),
				)
			}
			if (body.offset === 10) {
				return new Response(
					JSON.stringify({
						data: [apt1],
						count: 2,
					} satisfies StadtUndLandReponse),
				)
			}
			throw new Error(`unexpected request: ${href} ${JSON.stringify(body)}`)
		}) as unknown as typeof fetch)

		const listings = await sul.getListings()

		expect(listings).toHaveLength(2)
		const first = listings.find((l) => l.propertyId === "1001/5248/00229")
		const second = listings.find((l) => l.propertyId === "1050/8222/00113")
		expect(first?.newBuilding).toBe(false)
		expect(first?.location.neighborhood).toBe("Neukölln")
		expect(second?.newBuilding).toBe(true)
		expect(second?.location.neighborhood).toBe("Hellersdorf")
	})
})
