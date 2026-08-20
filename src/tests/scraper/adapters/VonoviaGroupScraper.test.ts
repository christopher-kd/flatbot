import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../../../logger/logger"
import Vonovia from "../../../scraper/adapters/Vonovia"
import type VonoviaGroupResponse from "../../../scraper/adapters/VonoviaGroup.types"
import ProxyClient from "../../../scraper/ProxyClient"
import type { ApartmentListing } from "../../../types"
import listPage1 from "../fixtures/vonoviagroup/listPage1.json"

type VonoviaResult = VonoviaGroupResponse["results"][number]

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/../fixtures/vonoviagroup/${name}`).text()
}

// listPage1's own paging.info.count (18) is honest about the real site
// having more results than this one captured page - fine for the
// pagination test, but tests that only care about a single page need a
// self-consistent count so fetchAllListings doesn't go looking for a
// second page this mock never routes.
function singlePageResponse(): VonoviaGroupResponse {
	return {
		paging: { info: { count: listPage1.results.length, limit: 15 } },
		results: listPage1.results as VonoviaResult[],
	}
}

function makeResult(overrides: Partial<VonoviaResult> = {}): VonoviaResult {
	return {
		wrk_id: "1",
		titel: "Test listing",
		strasse: "Teststr. 1",
		plz: "12345",
		ort: "Berlin OT Mitte",
		preis: 500,
		groesse: 50,
		anzahl_zimmer: 2,
		preview_img_url: "https://cdn.expose.vonovia.de/preview.jpg",
		imageUrls: [],
		slug: "test-listing-82-1234567890",
		vermarktungsart_kauf: "false",
		vermarktungsart_miete: "true",
		is_on_favlist: "false",
		object_viewed: false,
		tour_link_360: "",
		has_grundriss: false,
		lat: 52.5,
		lng: 13.4,
		...overrides,
	}
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "82-1234567890",
		organization: "Vonovia",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl:
			"https://vonovia.de/zuhause-finden/immobilien/test-listing-82-1234567890",
		location: {
			postalCode: "12345",
			city: "Berlin",
			street: "Teststr.",
			houseNumber: "1",
		},
		spaceQm: 50,
		rooms: 2,
		restrictions: null,
		costs: { coldRentEur: 500 },
		images: [],
		...overrides,
	}
}

function makeIncompleteListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return makeListing({
		costs: {
			coldRentEur: 500,
			depositEur: undefined,
			heatingEur: undefined,
			utilityEur: undefined,
			totalRentEur: undefined,
		},
		newBuilding: undefined,
		features: undefined,
		accessibility: undefined,
		...overrides,
	})
}

describe("VonoviaGroupScraper.extractListing", () => {
	test("parses a real listing from the search API", () => {
		const vonovia = new Vonovia()

		const [listing] = vonovia.extractListing(
			listPage1.results[0] as VonoviaResult,
		)

		expect(listing.propertyId).toBe("82-1186330004")
		expect(listing.fullUrl).toBe(
			"https://vonovia.de/zuhause-finden/immobilien/schoene-und-geraeumige-2-zimmerwohnung-mit-balkon-ins-gruene-82-1186330004",
		)
		expect(listing.location).toEqual({
			street: "Lichtenrader Damm",
			houseNumber: "138",
			city: "Berlin",
			neighborhood: "Lichtenrade",
			postalCode: "12305",
			coordinates: { type: "Point", coordinates: [13.4088797, 52.3878788] },
		})
		expect(listing.spaceQm).toBe(63.25)
		expect(listing.rooms).toBe(2)
		expect(listing.restrictions).toBeNull()
		expect(listing.costs).toEqual({ coldRentEur: 899.71 })
	})

	test("every real result on the captured page parses with a district (OT segment present)", () => {
		const vonovia = new Vonovia()

		for (const result of listPage1.results) {
			const [listing] = vonovia.extractListing(result as VonoviaResult)
			expect(listing.location.neighborhood).toBeTruthy()
		}
	})

	test("neighborhood is undefined when ort has no OT segment", () => {
		const vonovia = new Vonovia()
		const result = makeResult({ ort: "Berlin" })

		const [listing] = vonovia.extractListing(result)

		expect(listing.location.city).toBe("Berlin")
		expect(listing.location.neighborhood).toBeUndefined()
	})

	test("lat/lng of exactly 0,0 is treated as null-island (unfilled), not a real coordinate", () => {
		const vonovia = new Vonovia()
		const result = makeResult({ lat: 0, lng: 0 })

		const [listing] = vonovia.extractListing(result)

		expect(listing.location.coordinates).toBeNull()
	})

	test("returns an empty array and logs a warning when the slug has no extractable propertyId", () => {
		const vonovia = new Vonovia()
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const result = makeResult({ slug: "no-property-id-here" })

		const listings = vonovia.extractListing(result)

		expect(listings).toEqual([])
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})
})

describe("VonoviaGroupScraper.fetchDetails / backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses the real detail page's key/value table and equipment list", async () => {
		const vonovia = new Vonovia()
		const html = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))

		const details = await vonovia.fetchDetails("https://example.com")

		expect(details.tableData.get("Kaltmiete")).toBe("899,71 €")
		expect(details.tableData.get("Nebenkosten")).toBe("207,00 €")
		expect(details.tableData.get("Heizkosten")).toBe("95,00 €")
		expect(details.tableData.get("Kaution")).toBe("2.699,13 €")
		expect(details.tableData.get("Baujahr")).toBe("1998")
		expect(details.features).toContain("Barrierearmes Gebäude")
		expect(details.features).not.toContain("Barrierefrei")
	})

	test("backfill fills costs/newBuilding/features, and barrierFree is false for 'Barrierearm' (not the same claim as barrierefrei)", async () => {
		const vonovia = new Vonovia()
		const html = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(html))
		const target = makeIncompleteListing()

		await vonovia.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 500,
			depositEur: 2699.13,
			heatingEur: 95,
			utilityEur: 207,
			totalRentEur: 1201.71,
		})
		expect(target.newBuilding).toBe(false) // Baujahr 1998
		expect(target.features?.length).toBeGreaterThan(0)
		expect(target.accessibility?.barrierFree).toBe(false)
		expect(target.accessibility?.senior).toBe(false)
	})

	test("skips a listing whose backfillable fields are already fully populated", async () => {
		const vonovia = new Vonovia()
		const fetchSpy = spyOn(globalThis, "fetch")
		const complete = makeListing({
			costs: {
				coldRentEur: 500,
				depositEur: 1,
				heatingEur: 1,
				utilityEur: 1,
				totalRentEur: 1,
			},
			newBuilding: false,
			features: ["existing"],
			accessibility: { barrierFree: false, senior: false },
		})

		await vonovia.backfill([complete])

		expect(fetchSpy).not.toHaveBeenCalled()
	})

	test("one listing's fetch failure doesn't block a sibling's backfill", async () => {
		const vonovia = new Vonovia()
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const html = await loadFixtureText("detail.html")
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			if (href.includes("broken")) throw new Error("network down")
			return new Response(html)
		}) as unknown as typeof fetch)
		const broken = makeIncompleteListing({
			propertyId: "broken-id",
			fullUrl: "https://vonovia.de/zuhause-finden/immobilien/broken",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl: "https://vonovia.de/zuhause-finden/immobilien/healthy",
		})

		await vonovia.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(false)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})

describe("VonoviaGroupScraper.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates real data across offsets and dedupes", async () => {
		const vonovia = new Vonovia()
		spyOn(ProxyClient.prototype, "getWorkingProxies").mockResolvedValue([])
		// Only 15 real results were captured; synthesize a small 2nd
		// page from 3 of those same real records (re-used, not fabricated)
		// so pagination past the first page is genuinely exercised.
		const page2Results = listPage1.results.slice(0, 3) as VonoviaResult[]
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			const isSecondPage = href.includes("offset=15")
			const page: VonoviaGroupResponse = isSecondPage
				? { paging: { info: { count: 18, limit: 15 } }, results: page2Results }
				: (listPage1 as VonoviaGroupResponse)
			return new Response(JSON.stringify(page))
		}) as unknown as typeof fetch)

		const listings = await vonovia.getListings()

		expect(listings).toHaveLength(18)
	})

	test("falls back to a proxy when the direct request is blocked (406)", async () => {
		const vonovia = new Vonovia()
		spyOn(ProxyClient.prototype, "getWorkingProxies").mockResolvedValue([
			"http://proxy.example:8080",
		])
		spyOn(globalThis, "fetch").mockImplementation((async (
			_url: string | URL,
			init?: BunFetchRequestInit,
		) => {
			if (!init?.proxy) {
				return new Response("blocked", {
					status: 406,
					statusText: "Not Acceptable",
				})
			}
			return new Response(JSON.stringify(singlePageResponse()))
		}) as unknown as typeof fetch)

		const listings = await vonovia.getListings()

		expect(listings).toHaveLength(15)
	})

	test("tries the next proxy candidate when the first one is itself blocked, before any real data is captured", async () => {
		const vonovia = new Vonovia()
		spyOn(ProxyClient.prototype, "getWorkingProxies").mockResolvedValue([
			"http://bad-proxy.example:8080",
			"http://good-proxy.example:8080",
		])
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		spyOn(globalThis, "fetch").mockImplementation((async (
			_url: string | URL,
			init?: BunFetchRequestInit,
		) => {
			if (!init?.proxy) {
				return new Response("blocked", {
					status: 406,
					statusText: "Not Acceptable",
				})
			}
			if (init.proxy === "http://bad-proxy.example:8080") {
				throw new Error("proxy connection refused")
			}
			return new Response(JSON.stringify(singlePageResponse()))
		}) as unknown as typeof fetch)

		const listings = await vonovia.getListings()

		expect(listings).toHaveLength(15)
		expect(
			warnSpy.mock.calls.some((call) =>
				String(call[0]).includes("trying next proxy"),
			),
		).toBe(true)
	})

	test("throws when direct fails and no proxy is available", async () => {
		const vonovia = new Vonovia()
		spyOn(ProxyClient.prototype, "getWorkingProxies").mockResolvedValue([])
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("blocked", { status: 406, statusText: "Not Acceptable" }),
		)

		let error: unknown
		try {
			await vonovia.getListings()
		} catch (err) {
			error = err
		}

		expect(error).toBeInstanceOf(Error)
	})
})
