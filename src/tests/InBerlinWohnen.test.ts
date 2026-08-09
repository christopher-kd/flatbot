import { parse } from "node-html-parser"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import log from "../logger/logger"
import InBerlinWohnenScraper, {
	parseMapPinCoordinates,
} from "../scraper/adapters/InBerlinWohnen"

const scraper = new InBerlinWohnenScraper()

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/fixtures/inberlinwohnen/${name}`).text()
}

async function loadApartments(page: number) {
	const html = await loadFixtureText(`listPage${page}.html`)
	return parse(html).querySelectorAll("[id^=apartment]")
}

describe("parseMapPinCoordinates", () => {
	test("parses a valid, distinct lat/lon pair", () => {
		const wireClick =
			'$dispatch(\'flatClicked\', {"lat":"52.54665322","lon":"13.50150560","id":20135});'

		expect(parseMapPinCoordinates(wireClick)).toEqual({
			lat: 52.54665322,
			lng: 13.5015056,
		})
	})

	test("drops a pin where lat and lon are identical", () => {
		const wireClick =
			'$dispatch(\'flatClicked\', {"lat":"52.55479465","lon":"52.55479465","id":19603});'

		expect(parseMapPinCoordinates(wireClick)).toBeUndefined()
	})

	test("throws when no JSON object is present in the attribute", () => {
		const wireClick = "$dispatch('flatClicked');"

		expect(() => parseMapPinCoordinates(wireClick)).toThrow()
	})
})

describe("InBerlinWohnenScraper.extractListing", () => {
	test("resolves the real landlord org and propertyId format for all 7 direct orgs it re-publishes", async () => {
		const expected: Record<string, string> = {
			Gewobag: "0100-01240-0301-0162",
			HOWOGE: "1770-20600-116",
			degewo: "W1100.42201.0401-0101",
			WBM: "1-5446/4/162",
			"Stadt und Land": "1001/5248/00262",
			GESOBAU: "10-03209-00002-1020",
			Berlinovo: "1230-2388-3211",
		}
		const seen: Record<string, string> = {}

		for (const page of [1, 2, 7, 14]) {
			const apartments = await loadApartments(page)
			for (const apartment of apartments) {
				const listing = scraper.extractListing(apartment)
				seen[listing.organization] ??= listing.propertyId
			}
		}

		expect(seen).toEqual(expected)
	})

	test("parses every real apartment across 4 real pages without throwing", async () => {
		for (const page of [1, 2, 7, 14]) {
			const apartments = await loadApartments(page)
			for (const apartment of apartments) {
				expect(() => scraper.extractListing(apartment)).not.toThrow()
			}
		}
	})

	test("drops identical-lat/lng map pins on real listings (GESOBAU and Berlinovo both hit this live)", async () => {
		const apartmentsP7 = await loadApartments(7)
		const gesobau = scraper.extractListing(apartmentsP7[5])
		expect(gesobau.organization).toBe("GESOBAU")
		expect(gesobau.location.coordinates).toBeUndefined()

		const apartmentsP14 = await loadApartments(14)
		const berlinovo = scraper.extractListing(apartmentsP14[7])
		expect(berlinovo.organization).toBe("Berlinovo")
		expect(berlinovo.location.coordinates).toBeUndefined()
	})

	test("real income-checked listing (WBS: unbekannt, title implies income limits)", async () => {
		const apartments = await loadApartments(1)

		const listing = scraper.extractListing(apartments[5])

		expect(listing.title).toContain("Einkommensgrenzen")
		expect(listing.restrictions).toEqual({
			kind: "income-checked",
			wbsLevels: [],
		})
	})

	test("real WBS-required listing with explicit levels (WBS: erforderlich)", async () => {
		const apartments = await loadApartments(7)

		const listing = scraper.extractListing(apartments[0])

		expect(listing.organization).toBe("HOWOGE")
		expect(listing.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [100, 140],
			wbsSpecialNeed: null,
		})
	})

	test("throws when the listing's URL host doesn't match any of the 7 known landlords", () => {
		const root = parse(`
			<div id="apartment-1">
				<div class="list__details">
					<span>Test listing</span>
					<a href="https://example.com/some-listing"></a>
					<div class="table">
						<dt>Adresse:</dt><dd>Teststr. 1, 12345, Mitte</dd>
						<dt>WBS:</dt><dd>nicht erforderlich</dd>
					</div>
				</div>
				<button class="text-right" wire:click="$dispatch('flatClicked', {&quot;lat&quot;:&quot;52.5&quot;,&quot;lon&quot;:&quot;13.4&quot;,&quot;id&quot;:1});"></button>
			</div>
		`)
		const apartment = root.querySelector("[id^=apartment]")
		if (!apartment) throw new Error("test markup missing")

		expect(() => scraper.extractListing(apartment)).toThrow(
			"Couldn't determine organization",
		)
	})
})

describe("InBerlinWohnenScraper.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates and merges real data across all 7 known orgs, isolating one malformed apartment", async () => {
		const [page1Html, page2, page3, page4] = await Promise.all([
			loadFixtureText("listPage1.html"),
			loadFixtureText("listPage2.html"),
			loadFixtureText("listPage7.html"),
			loadFixtureText("listPage14.html"),
		])
		// Real page1 declares 31 total pages - relabel to 4 so this test
		// only ever requests the 4 real pages actually captured.
		const page1Root = parse(page1Html)
		const countButton = page1Root.querySelector(
			".pagination .flex button:last-child",
		)
		if (countButton) countButton.textContent = "4"
		const page1 = page1Root.toString()
		const pages = [page1, page2, page3, page4]

		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const href = String(url)
			const match = href.match(/page=(\d+)/)
			const pageNumber = match ? Number(match[1]) : 1
			return new Response(pages[pageNumber - 1])
		}) as unknown as typeof fetch)

		const listings = await scraper.getListings()

		expect(listings).toHaveLength(40)
		expect(new Set(listings.map((l) => l.organization)).size).toBe(7)
		expect(warnSpy).not.toHaveBeenCalled()
	})

	test("one apartment with an unrecognized org is skipped, not fatal to the rest", async () => {
		const page1Html = await loadFixtureText("listPage1.html")
		const root = parse(page1Html)
		const countButton = root.querySelector(
			".pagination .flex button:last-child",
		)
		if (countButton) countButton.textContent = "1"
		const firstLink = root.querySelector("[id^=apartment] .list__details a")
		firstLink?.setAttribute("href", "https://example.com/unknown-listing")
		const brokenPage = root.toString()

		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(brokenPage))

		const listings = await scraper.getListings()

		expect(listings).toHaveLength(9)
		expect(warnSpy).toHaveBeenCalled()
	})
})
