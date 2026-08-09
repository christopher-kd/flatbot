import { parse } from "node-html-parser"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import Howoge from "../scraper/adapters/Howoge"
import type { ApartmentListing } from "../types"
import immoList from "./fixtures/howoge/immoList.json"

const howoge = new Howoge()
const TEASER_URL =
	"https://www.howoge.de/immobiliensuche/neubauprojekte/sewanstrasse-256-a-c.html"
const DETAIL_PROPERTY_ID = "1771-14536-9997"

type Immo = (typeof immoList.immoobjects)[number]

function findImmo(predicate: (o: Immo) => boolean): Immo {
	const immo = immoList.immoobjects.find(predicate)
	if (!immo) throw new Error("fixture immo not found")
	return immo
}

async function loadTeaserFlats() {
	const html = await Bun.file(
		`${import.meta.dir}/fixtures/howoge/projectTeaser.html`,
	).text()
	return parse(html).querySelectorAll(".flat-single")
}

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/howoge/${name}`).text()
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "HOWOGE",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://howoge.de/1",
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

describe("Howoge.extractListing", () => {
	test("parses a WBS-required listing from the immoobjects feed", () => {
		const immo = findImmo((o) => o.wbs === "ja")

		const listing = howoge.extractListing(immo)

		expect(listing.propertyId).toBe("1771-14536-9997")
		expect(listing.fullUrl).toBe(
			"https://howoge.de/immobiliensuche/wohnungssuche/detail/1771-14536-9997.html",
		)
		expect(listing.location).toEqual({
			postalCode: "13587",
			city: "Berlin",
			street: "Streitstraße",
			houseNumber: "5",
			neighborhood: "Hakenfelde",
			coordinates: { lat: 52.5575599, lng: 13.209115 },
		})
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [100, 140],
			wbsSpecialNeed: null,
		})
		expect(listing.costs).toEqual({ totalRentEur: 803 })
		expect(listing.spaceQm).toBe(73)
		expect(listing.rooms).toBe(3)
	})

	test("classifies off immo.notice, not immo.title (which is actually the street address)", () => {
		const immo = findImmo((o) => o.wbs === "ja")

		const listing = howoge.extractListing(immo)

		expect(immo.title).toBe("Streitstraße 5, 13587 Berlin")
		expect(listing.title).toBe("3-Zimmer-Wohnung (WBS 100-140)")
		expect(listing.title).not.toBe(immo.title)
	})

	test("treats wbs: nein as unrestricted, regardless of city", () => {
		const immo = findImmo((o) => o.wbs === "nein")

		const listing = howoge.extractListing(immo)

		expect(listing.location.city).toBe("Panketal")
		expect(listing.restrictions).toEqual({ kind: "free" })
	})

	test("detects barrierefrei from the features list", () => {
		const immo = findImmo((o) => o.features.includes("barrierefrei"))

		const listing = howoge.extractListing(immo)

		expect(listing.accessibility).toEqual({
			wheelchair: false,
			barrierFree: true,
		})
	})

	test("detects rollstuhlgerecht as wheelchair accessibility", () => {
		const immo = findImmo((o) => o.features.includes("rollstuhlgerecht"))

		const listing = howoge.extractListing(immo)

		expect(listing.accessibility).toEqual({
			wheelchair: true,
			barrierFree: false,
		})
	})
})

describe("Howoge.extractTeaserListing", () => {
	test("parses a project-teaser flat, which never has coordinates from HOWOGE's own site", async () => {
		const flats = await loadTeaserFlats()

		const listing = howoge.extractTeaserListing(flats[0], TEASER_URL)

		expect(listing.propertyId).toBe("1770-20551-9999")
		expect(listing.fullUrl).toBe(
			"https://howoge.de/immobiliensuche/wohnungssuche/detail/1770-20551-9999.html",
		)
		expect(listing.location).toEqual({
			postalCode: "10319",
			city: "Berlin",
			street: "Sewanstraße",
			houseNumber: "256 A",
		})
		expect(listing.location.coordinates).toBeUndefined()
		expect(listing.costs).toEqual({ totalRentEur: 367.5 })
		expect(listing.spaceQm).toBe(35)
		expect(listing.rooms).toBe(1)
		expect(listing.newBuilding).toBe(true)
	})

	test("parses every teaser flat on the page without throwing", async () => {
		const flats = await loadTeaserFlats()

		const listings = flats.map((flat) =>
			howoge.extractTeaserListing(flat, TEASER_URL),
		)

		expect(listings).toHaveLength(8)
		expect(new Set(listings.map((l) => l.propertyId)).size).toBe(8)
	})
})

describe("Howoge.fetchDetailTable", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses cost/fact table and features from a real detail page", async () => {
		const html = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))

		const { map, features } = await howoge.fetchDetailTable(DETAIL_PROPERTY_ID)

		expect(map.get("Kaltmiete")).toBe("511,00 €")
		expect(map.get("Nebenkosten")).toBe("292,00 €")
		expect(map.get("Warmmiete")).toBe("803,00 €")
		expect(map.get("Kaution")).toBe("1533,00 €")
		expect(map.get("Baujahr")).toBe("2026")
		// This real listing's table has no "Heizkosten:" row at all.
		expect(map.get("Heizkosten")).toBeUndefined()
		expect(features).toEqual([
			"WBS erforderlich",
			"Bad mit Dusche",
			"offene Küche",
			"Fußbodenheizung",
			"Zentralheizung",
			"Aufzug",
			"KabelTV-Anschluss",
			"Mieterkeller",
		])
	})

	test("requests the detail page for the given propertyId", async () => {
		const html = await loadFixtureText("detail.html")
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(html),
		)

		await howoge.fetchDetailTable(DETAIL_PROPERTY_ID)

		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			`https://www.howoge.de/immobiliensuche/wohnungssuche/detail/${DETAIL_PROPERTY_ID}.html`,
		)
	})
})

describe("Howoge.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

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

	test("fills costs/newBuilding/features from the detail page; heatingEur is null when the row is absent", async () => {
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing({ propertyId: DETAIL_PROPERTY_ID })

		await howoge.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 511,
			utilityEur: 292,
			totalRentEur: 803,
			depositEur: 1533,
			heatingEur: null,
		})
		expect(target.newBuilding).toBe(true)
		expect(target.features).toHaveLength(8)
	})

	test("skips a listing whose backfillable fields are already fully populated", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
		const complete = makeListing({
			propertyId: "already-done",
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

		await howoge.backfill([complete])

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(complete.features).toEqual(["existing"])
	})

	test("one listing's fetch failure doesn't block a sibling's backfill", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const detailHtml = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			if (href.includes("broken-id")) throw new Error("network down")
			return new Response(detailHtml)
		}) as unknown as typeof fetch)
		const broken = makeIncompleteListing({ propertyId: "broken-id" })
		const healthy = makeIncompleteListing({ propertyId: DETAIL_PROPERTY_ID })

		await howoge.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(true)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})

describe("Howoge.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("merges the immoobjects feed with project-teaser pages, isolating a broken teaser page", async () => {
		const teaserHtml = await loadFixtureText("projectTeaser.html")
		const immo = findImmo((o) => o.wbs === "ja")
		const okTeaserUrl =
			"https://www.howoge.de/immobiliensuche/neubauprojekte/ok-project.html"
		const brokenTeaserUrl =
			"https://www.howoge.de/immobiliensuche/neubauprojekte/broken-project.html"
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)

		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
			init?: RequestInit,
		) => {
			if (init?.method === "POST") {
				return new Response(
					JSON.stringify({
						immocount: 1,
						teasercount: 2,
						immoobjects: [immo],
						projectteaser: [{ link: okTeaserUrl }, { link: brokenTeaserUrl }],
						badges: [],
					}),
				)
			}
			const href = String(url)
			if (href === okTeaserUrl) return new Response(teaserHtml)
			if (href === brokenTeaserUrl) throw new Error("teaser page down")
			throw new Error(`unexpected fetch: ${href}`)
		}) as unknown as typeof fetch)

		const listings = await howoge.getListings()

		expect(
			listings.filter((l) => l.propertyId === DETAIL_PROPERTY_ID),
		).toHaveLength(1)
		expect(
			listings.filter((l) => l.propertyId.startsWith("1770-20551")),
		).toHaveLength(8)
		expect(listings).toHaveLength(9)
		expect(
			warnSpy.mock.calls.some((call) =>
				String(call[0]).includes(brokenTeaserUrl),
			),
		).toBe(true)
	})
})
