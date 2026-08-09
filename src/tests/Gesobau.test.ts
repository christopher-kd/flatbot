import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import Gesobau from "../scraper/adapters/Gesobau"
import type GesobauResponse from "../scraper/adapters/Gesobau.types"
import type { ApartmentListing } from "../types"
import listings from "./fixtures/gesobau/listings.json"

const gesobau = new Gesobau()

type Immo = (typeof listings)[number]

function findImmo(predicate: (o: Immo) => boolean): Immo {
	const immo = listings.find(predicate)
	if (!immo) throw new Error("fixture immo not found")
	return immo
}

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/gesobau/${name}`).text()
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "GESOBAU",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://gesobau.de/mieten/wohnungssuche/detailseite/1/",
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

describe("Gesobau.extractListing", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses a real listing whose room count comes straight from the search JSON", async () => {
		const immo = findImmo(
			(o) => o.raw.zimmer_intS === 1 && !!o.raw.fuerSenioren_boolS,
		)

		const listing = await gesobau.extractListing(immo)

		expect(listing.propertyId).toBe("10-03243-00016-1276")
		expect(listing.fullUrl).toBe(
			"https://gesobau.de/mieten/wohnungssuche/detailseite/zossener-strasse-10-03243-00016-1276-55a549d7-2fee-46b2-8500-d171fce189e0/",
		)
		expect(listing.location).toEqual({
			street: "Zossener Straße",
			postalCode: "12629",
			city: "Berlin",
			neighborhood: "Marzahn-Hellersdorf",
			houseNumber: "152",
			coordinates: { lat: 52.54371, lng: 13.59482 },
		})
		expect(listing.spaceQm).toBe(44.73)
		expect(listing.rooms).toBe(1)
		expect(listing.accessibility).toEqual({
			wheelchair: false,
			senior: true,
			barrierFree: true,
		})
		expect(listing.restrictions).toEqual({ kind: "free" })
		expect(listing.costs).toEqual({ totalRentEur: 773.1 })
	})

	test("falls back to fetching the detail page for room count when zimmer_intS is missing from the JSON", async () => {
		const immo = findImmo((o) => o.raw.zimmer_intS === undefined)
		const detailHtml = await loadFixtureText("detailNoRoomCount.html")
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(detailHtml),
		)

		const listing = await gesobau.extractListing(immo)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(listing.propertyId).toBe("10-00028-00101-0140")
		expect(listing.rooms).toBe(2.5) // "2,5 Zimmer" on the real detail page
	})

	test("extracts a WBS level and special-need from a real restricted title", async () => {
		const immo = findImmo((o) => o.raw.title.includes("BESONDEREM WOHNBEDARF"))

		const listing = await gesobau.extractListing(immo)

		expect(listing.title).toContain("WBS 180")
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [180],
			wbsSpecialNeed: "required",
		})
	})

	test("throws when a required raw field is missing - getListings catches this per-item, see below", async () => {
		const immo = findImmo((o) => o.raw.zimmer_intS === 1)
		const broken: GesobauResponse[number] = {
			...(immo as unknown as GesobauResponse[number]),
			raw: { ...immo.raw, wohnflaeche_floatS: undefined },
		}

		let error: unknown
		try {
			await gesobau.extractListing(broken)
		} catch (err) {
			error = err
		}

		expect(error).toBeInstanceOf(Error)
	})
})

describe("Gesobau.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses every real listing, using the detail-page fallback for the two missing room counts", async () => {
		const detailHtml = await loadFixtureText("detailNoRoomCount.html")
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			if (href.includes("wohnungssuche/detailseite")) {
				return new Response(detailHtml)
			}
			return new Response(JSON.stringify(listings))
		}) as unknown as typeof fetch)

		const result = await gesobau.getListings()

		// 54 raw JSON entries, but the propertyId regex only extracts the
		// numeric ID (not the trailing UUID that makes each raw entry
		// unique) - several real entries share one propertyId (same unit,
		// re-listed under a different internal UUID), correctly collapsed
		// by dedupeByPropertyId.
		expect(result).toHaveLength(50)
		expect(new Set(result.map((l) => l.propertyId)).size).toBe(50)
	})

	test("one listing missing a required field is skipped, not fatal to the rest", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		// Pick one that already has zimmer_intS, so extractListing never
		// needs the detail-page fallback fetch this test doesn't mock.
		const targetIndex = listings.findIndex((l) => l.raw.zimmer_intS === 1)
		const withOneBroken = listings.map((l, i) =>
			i === targetIndex
				? { ...l, raw: { ...l.raw, wohnflaeche_floatS: undefined } }
				: l,
		)
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(withOneBroken)),
		)

		const result = await gesobau.getListings()

		// The key signal is that this resolves at all (no per-item
		// isolation would mean the whole call rejects instead).
		expect(result.length).toBeGreaterThan(0)
		expect(warnSpy).toHaveBeenCalled()
	})
})

describe("Gesobau.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("fills costs, newBuilding and features from a real detail page", async () => {
		const detailHtml = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing()

		await gesobau.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 598.65,
			utilityEur: 152.69,
			heatingEur: 67.1,
			depositEur: 1795.95,
			totalRentEur: undefined,
		})
		expect(target.newBuilding).toBe(true) // Baujahr 2022
		expect(target.features).toEqual([
			"Aufzug",
			"TV / Sat / Kabel",
			"Keller",
			"Dusche",
			"Balkon",
			"Terrasse",
		])
	})

	test("a missing detail table leaves the listing untouched (undefined, safe to retry next run)", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html><body>no table here</body></html>"),
		)
		const target = makeIncompleteListing()

		await gesobau.backfill([target])

		expect(target.costs.coldRentEur).toBeUndefined()
		expect(target.newBuilding).toBeUndefined()
		expect(warnSpy).toHaveBeenCalled()
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

		await gesobau.backfill([complete])

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
			fullUrl: "https://gesobau.de/mieten/wohnungssuche/detailseite/broken/",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl: "https://gesobau.de/mieten/wohnungssuche/detailseite/healthy/",
		})

		await gesobau.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(true)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})
