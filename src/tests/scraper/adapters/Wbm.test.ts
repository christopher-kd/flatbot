import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { parse } from "node-html-parser"
import log from "../../../logger/logger"
import Wbm from "../../../scraper/adapters/Wbm"
import type { ApartmentListing } from "../../../types"

const wbm = new Wbm()

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/../fixtures/wbm/${name}`).text()
}

async function loadListItems() {
	const html = await loadFixtureText("listPage.html")
	return parse(html).querySelectorAll(".openimmo-search-list-item")
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "WBM",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://wbm.de/1",
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

function makeIncompleteListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return makeListing({
		costs: {
			coldRentEur: undefined,
			utilityEur: undefined,
			totalRentEur: undefined,
			depositEur: undefined,
			heatingEur: undefined,
		},
		newBuilding: undefined,
		accessibility: undefined,
		...overrides,
	})
}

describe("Wbm.extractListing", () => {
	test("parses a real listing from the search results page", async () => {
		const items = await loadListItems()

		const listing = wbm.extractListing(items[0])

		expect(listing?.propertyId).toBe("60-7903/29/464")
		expect(listing?.fullUrl).toBe(
			"https://wbm.de/wohnungen-berlin/angebote/details/helle-3-zimmer-dachgeschosswohnung-in-spandau/",
		)
		expect(listing?.location).toEqual({
			street: "Goltzstrasse",
			postalCode: "13587",
			houseNumber: "49",
			city: "Berlin",
			neighborhood: "Spandau",
		})
		expect(listing?.spaceQm).toBe(106.63)
		expect(listing?.rooms).toBe(3)
		expect(listing?.restrictions).toEqual({ kind: "free" })
		expect(listing?.costs).toEqual({ totalRentEur: 1692.56 })
		expect(listing?.features).toEqual([
			"Bad mit Wanne",
			"Aufzug",
			"Offene Küche",
			"Balkon",
			"Abstellraum",
		])
		expect(listing?.images).toEqual([
			{
				fullUrl:
					"https://wbm.de/fileadmin/user_upload/tx_openimmo/connection-3/images/77413-12a1ea826e5d73f0fedb59da7d226c9f.jpg",
			},
		])
	})

	test("returns null and logs a warning when data-id is missing, instead of throwing", () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const root = parse(
			'<div class="openimmo-search-list-item"><h2>Test</h2></div>',
		)
		const listing = root.querySelector(".openimmo-search-list-item")
		if (!listing) throw new Error("test markup missing")

		const result = wbm.extractListing(listing)

		expect(result).toBeNull()
		expect(warnSpy).toHaveBeenCalledTimes(1)
		warnSpy.mockRestore()
	})
})

describe("Wbm.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses every real listing on the search results page", async () => {
		const html = await loadFixtureText("listPage.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))

		const listings = await wbm.getListings()

		expect(listings).toHaveLength(25)
		expect(new Set(listings.map((l) => l.propertyId)).size).toBe(25)
	})
})

describe("Wbm.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("fills costs and newBuilding from the detail page; heatingEur is always null", async () => {
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing()

		await wbm.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 1279.56,
			utilityEur: 413,
			totalRentEur: 1692.56,
			depositEur: 3838.68,
			heatingEur: null,
		})
		expect(target.newBuilding).toBe(true)
	})

	test("barrierFree is null when neither title nor intro text mentions it", async () => {
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing({ title: "Helle Wohnung" })

		await wbm.backfill([target])

		expect(target.accessibility?.barrierFree).toBeNull()
		expect(target.accessibility?.wheelchair).toBeUndefined()
	})

	test("barrierFree is true when the listing's own title mentions it", async () => {
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing({ title: "Barrierefreie Wohnung" })

		await wbm.backfill([target])

		expect(target.accessibility?.barrierFree).toBe(true)
	})

	test("wheelchair is set true when the intro text mentions rollstuhl, left untouched otherwise", async () => {
		const rollstuhlHtml =
			'<div class="openimmo-detail__intro-text">Rollstuhlgerecht ausgebaut</div>'
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(rollstuhlHtml))
		const target = makeIncompleteListing()

		await wbm.backfill([target])

		expect(target.accessibility?.wheelchair).toBe(true)
	})

	test("skips listing whose backfillable fields are already fully populated", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
		const complete = makeListing({
			costs: {
				coldRentEur: 1,
				utilityEur: 1,
				totalRentEur: 1,
				depositEur: 1,
				heatingEur: 1,
			},
			newBuilding: false,
			accessibility: { barrierFree: false },
		})

		await wbm.backfill([complete])

		expect(fetchSpy).not.toHaveBeenCalled()
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
		const broken = makeIncompleteListing({
			propertyId: "broken-id",
			fullUrl: "https://wbm.de/broken",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl: "https://wbm.de/healthy",
		})

		await wbm.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(true)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})
