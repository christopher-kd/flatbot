import { parse } from "node-html-parser"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import Berlinovo from "../scraper/adapters/Berlinovo"
import type { ApartmentListing } from "../types"

const berlinovo = new Berlinovo()

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/berlinovo/${name}`).text()
}

async function loadListItems(page: number) {
	const html = await loadFixtureText(`listPage${page}.html`)
	return parse(html).querySelectorAll(".view article")
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "Berlinovo",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://berlinovo.de/wohnung-id/1",
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
		spaceQm: undefined,
		costs: {
			coldRentEur: undefined,
			utilityEur: undefined,
			totalRentEur: undefined,
			depositEur: undefined,
			heatingEur: undefined,
		},
		newBuilding: undefined,
		features: undefined,
		accessibility: undefined,
		...overrides,
	})
}

describe("Berlinovo.extractListing", () => {
	test("parses a real free listing from the search results page", async () => {
		const items = await loadListItems(1)

		const listing = berlinovo.extractListing(items[0])

		expect(listing.propertyId).toBe("3016-2137-187")
		expect(listing.fullUrl).toBe(
			"https://berlinovo.de/wohnung-id/3016-2137-187",
		)
		expect(listing.location).toEqual({
			city: "Berlin",
			postalCode: "12355",
			street: "Lieselotte-Berger-Str.",
			houseNumber: "49",
		})
		expect(listing.rooms).toBe(1.5)
		expect(listing.costs).toEqual({ totalRentEur: 760 })
		expect(listing.restrictions).toEqual({ kind: "free" })
		// Never present at scrape time - filled by backfill() only.
		expect(listing.spaceQm).toBeUndefined()
	})

	test("detects WBS-required from the DOM marker even when the title has no WBS text at all", async () => {
		const items = await loadListItems(4)

		const listing = berlinovo.extractListing(items[0])

		expect(listing.title).not.toContain("WBS")
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [],
			wbsSpecialNeed: null,
		})
	})

	test("extracts WBS levels and special-need from a real restricted title", async () => {
		const items = await loadListItems(2)

		const listing = berlinovo.extractListing(items[7])

		expect(listing.title).toContain("WBS 100-140")
		expect(listing.title).toContain("besonderem Wohnbedarf")
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [100, 140],
			wbsSpecialNeed: "required",
		})
	})

	test("parses every listing across every real page without throwing", async () => {
		for (let page = 1; page <= 9; page++) {
			const items = await loadListItems(page)
			for (const item of items) {
				expect(() => berlinovo.extractListing(item)).not.toThrow()
			}
		}
	})
})

describe("Berlinovo.fetchDetails", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses the cost/fact table from a real detail page", async () => {
		const html = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))

		const details = await berlinovo.fetchDetails("https://example.com")

		expect(details.map.get("Kaltmiete")).toBe("565,00 €")
		expect(details.map.get("Nebenkosten")).toBe("105,00 €")
		expect(details.map.get("Heizkosten")).toBe("90.00 €")
		expect(details.map.get("Bruttogesamtmiete")).toBe("760.00 €")
		expect(details.map.get("Baujahr")).toBe("1998")
		expect(details.map.get("Wohnfläche")).toBe("47,01 m²")
		expect(details.features).toEqual([
			"provisionsfrei",
			"Balkon/Terrasse vorhanden",
		])
		expect(details.depositClauseText).toContain("Nettokaltmieten Kaution")
		expect(details.descriptionText).not.toContain("barrierefrei")
	})

	test("a senior unit's real detail page has no deposit clause at all", async () => {
		const html = await loadFixtureText("detailSenior.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))

		const details = await berlinovo.fetchDetails("https://example.com")

		expect(details.depositClauseText.trim()).toBe("")
		expect(details.descriptionText).toContain("barrierefrei")
	})
})

describe("Berlinovo.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("applies the x3 deposit formula when the page's own text confirms a deposit clause", async () => {
		const html = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))
		const target = makeIncompleteListing({
			fullUrl: "https://berlinovo.de/wohnung-id/3016-2137-187",
		})

		await berlinovo.backfill([target])

		expect(target.costs.coldRentEur).toBe(565)
		expect(target.costs.depositEur).toBe(1695) // 565 x 3
		expect(target.costs.totalRentEur).toBe(760)
		expect(target.costs.heatingEur).toBe(90)
		expect(target.costs.utilityEur).toBe(105)
		expect(target.spaceQm).toBe(47.01)
		expect(target.newBuilding).toBe(false) // Baujahr 1998
		expect(target.accessibility?.barrierFree).toBeNull() // no match
	})

	test("depositEur is null for a senior unit whose page has no deposit clause, even though coldRentEur resolves", async () => {
		const html = await loadFixtureText("detailSenior.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))
		const target = makeIncompleteListing({
			fullUrl: "https://berlinovo.de/wohnung-id/1230-2389-1419",
		})

		await berlinovo.backfill([target])

		expect(target.costs.coldRentEur).toBe(740.7)
		expect(target.costs.depositEur).toBeNull()
		expect(target.newBuilding).toBe(true) // Baujahr 2025
		expect(target.accessibility?.barrierFree).toBe(true)
	})

	test("wheelchair is set true only when the unit-specific interior text mentions rollstuhl", async () => {
		const rollstuhlHtml = `
			<div class="details">
				<div class="content"></div>
			</div>
			<div class="field--name-field-interior2">Rollstuhlgerecht ausgebautes Bad</div>
		`
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(rollstuhlHtml))
		const target = makeIncompleteListing()

		await berlinovo.backfill([target])

		expect(target.accessibility?.wheelchair).toBe(true)
	})

	test("skips a listing whose backfillable fields are already fully populated", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
		const complete = makeListing({
			spaceQm: 50,
			costs: {
				coldRentEur: 1,
				utilityEur: 1,
				totalRentEur: 1,
				depositEur: 1,
				heatingEur: 1,
			},
			newBuilding: false,
			features: ["existing"],
			accessibility: { barrierFree: false },
		})

		await berlinovo.backfill([complete])

		expect(fetchSpy).not.toHaveBeenCalled()
	})

	test("one listing's fetch failure doesn't block a sibling's backfill", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const detailHtml = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			if (href.includes("broken")) throw new Error("network down")
			return new Response(detailHtml)
		}) as unknown as typeof fetch)
		const broken = makeIncompleteListing({
			propertyId: "broken-id",
			fullUrl: "https://berlinovo.de/wohnung-id/broken",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl: "https://berlinovo.de/wohnung-id/healthy",
		})

		await berlinovo.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(false)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})

describe("Berlinovo.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates across all 9 real pages and dedupes", async () => {
		const pages = await Promise.all(
			Array.from({ length: 9 }, (_, i) => i + 1).map((p) =>
				loadFixtureText(`listPage${p}.html`),
			),
		)
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			const match = href.match(/page=(\d+)/)
			const pageIndex = match ? Number(match[1]) : 0 // 0-indexed in the URL
			return new Response(pages[pageIndex])
		}) as unknown as typeof fetch)

		const listings = await berlinovo.getListings()

		expect(listings).toHaveLength(83)
		expect(new Set(listings.map((l) => l.propertyId)).size).toBe(83)
	})
})
