import { parse } from "node-html-parser"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import Gewobag from "../scraper/adapters/Gewobag"
import type { ApartmentListing } from "../types"

const gewobag = new Gewobag()

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/gewobag/${name}`).text()
}

async function loadListItems(page: number) {
	const html = await loadFixtureText(`listPage${page}.html`)
	return parse(html).querySelectorAll(".filtered-elements article")
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "Gewobag",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1/",
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
		features: undefined,
		...overrides,
	})
}

describe("Gewobag.extractListing", () => {
	test("parses a real WBS-fähig listing from the search results page", async () => {
		const items = await loadListItems(1)

		const listing = gewobag.extractListing(items[1])

		expect(listing.propertyId).toBe("0100-01241-0401-0090")
		expect(listing.fullUrl).toBe(
			"https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/0100-01241-0401-0090/",
		)
		expect(listing.location).toEqual({
			street: "Schluchseestr.",
			postalCode: "13469",
			houseNumber: "11",
			city: "Berlin",
			neighborhood: "Reinickendorf",
		})
		expect(listing.spaceQm).toBe(71.47)
		expect(listing.rooms).toBe(2)
		expect(listing.costs).toEqual({ totalRentEur: 959.82 })
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [],
			wbsSpecialNeed: null,
		})
		expect(listing.images.length).toBeGreaterThan(0)
	})

	test("classifies a plain title with no WBS mention as free", async () => {
		const items = await loadListItems(1)

		const listing = gewobag.extractListing(items[15])

		expect(listing.title).toBe("Wohnen im Lette Kiez")
		expect(listing.restrictions).toEqual({ kind: "free" })
	})

	test("extracts an explicit WBS level from the title", async () => {
		const items = await loadListItems(1)

		const listing = gewobag.extractListing(items[8])

		expect(listing.title).toContain("WBS 220")
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [220],
			wbsSpecialNeed: null,
		})
	})
})

describe("Gewobag.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates across all 4 real pages and dedupes", async () => {
		const pages = await Promise.all(
			[1, 2, 3, 4].map((p) => loadFixtureText(`listPage${p}.html`)),
		)
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			const match = href.match(/page\/(\d+)\//)
			const pageNumber = match ? Number(match[1]) : 1
			return new Response(pages[pageNumber - 1])
		}) as unknown as typeof fetch)

		const listings = await gewobag.getListings()

		expect(listings).toHaveLength(62)
		expect(new Set(listings.map((l) => l.propertyId)).size).toBe(62)
	})

	test("one malformed listing on a page is skipped, not fatal to the rest", async () => {
		const page1 = await loadFixtureText("listPage1.html")
		const root = parse(page1)
		// Strip the first article's <address> so it fails required() -
		// same real DOM shape, just missing the one selector this run.
		root
			.querySelectorAll(".filtered-elements article")[0]
			.querySelector("address")
			?.remove()
		const brokenPage1 = root.toString()
		const otherPages = await Promise.all(
			[2, 3, 4].map((p) => loadFixtureText(`listPage${p}.html`)),
		)
		const pages = [brokenPage1, ...otherPages]
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			const match = href.match(/page\/(\d+)\//)
			const pageNumber = match ? Number(match[1]) : 1
			return new Response(pages[pageNumber - 1])
		}) as unknown as typeof fetch)
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)

		const listings = await gewobag.getListings()

		expect(listings).toHaveLength(61)
		expect(warnSpy).toHaveBeenCalled()
	})
})

describe("Gewobag.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("fills costs, newBuilding (Neubau) and features from a real detail page", async () => {
		const detailHtml = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing()

		await gewobag.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 555.82,
			utilityEur: 404, // 192 (kalt) + 212 (warm)
			heatingEur: 212,
			depositEur: 1667.46,
			totalRentEur: undefined,
		})
		expect(target.newBuilding).toBe(true)
		expect(target.features).toEqual([
			"Fernheizung/Zentralheizung",
			"Fern-/Zentralwarmwasserversorgung",
			"Haustiere erlaubt",
		])
	})

	test("resolves every cost field to null (not undefined) from a sparse real detail page, no throw", async () => {
		const detailHtml = await loadFixtureText("detailSparse.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing()

		await gewobag.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: null,
			utilityEur: null,
			heatingEur: null,
			depositEur: null,
			totalRentEur: undefined,
		})
		expect(target.newBuilding).toBeNull()
		expect(target.features).toEqual([])
	})

	test("skips a listing whose backfillable fields are already fully populated", async () => {
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
			features: ["existing"],
		})

		await gewobag.backfill([complete])

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
			fullUrl:
				"https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/broken/",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl:
				"https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/healthy/",
		})

		await gewobag.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(true)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})
