import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { parse } from "node-html-parser"
import log from "../../../logger/logger"
import Degewo from "../../../scraper/adapters/Degewo"
import type { ApartmentListing } from "../../../types"

const degewo = new Degewo()

async function loadFixtureText(name: string): Promise<string> {
	return Bun.file(`${import.meta.dir}/../fixtures/degewo/${name}`).text()
}

async function loadTeasers(page: number) {
	const html = await loadFixtureText(`listPage${page}.html`)
	return parse(html).querySelectorAll(".c-teaser--apartment")
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		propertyId: "1",
		organization: "degewo",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://www.degewo.de/immosuche/details/1",
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
		accessibility: undefined,
		...overrides,
	})
}

describe("Degewo.extractListing", () => {
	afterEach(() => {
		mock.restore()
	})

	test("parses a real listing straight off the teaser (bookmark id present)", async () => {
		const teasers = await loadTeasers(1)

		const listing = await degewo.extractListing(teasers[0])

		expect(listing?.propertyId).toBe("W1400.40140.1390-0602")
		expect(listing?.fullUrl).toBe(
			"https://www.degewo.de/immosuche/details/meine-erste-wohnung-zentral-gelegen",
		)
		expect(listing?.location).toEqual({
			street: "Raoul-Wallenberg-Straße",
			houseNumber: "23",
			neighborhood: "Marzahn Mitte",
			city: "Berlin",
		})
		expect(listing?.spaceQm).toBe(29.48)
		expect(listing?.rooms).toBe(1)
		expect(listing?.costs).toEqual({ totalRentEur: 357.23 })
		expect(listing?.restrictions).toEqual({ kind: "free" })
	})

	test("extracts a WBS level from a real restricted listing's title", async () => {
		const teasers = await loadTeasers(1)

		const listing = await degewo.extractListing(teasers[8])

		expect(listing?.title).toBe("Nachmieter gesucht - 2-Zimmer nur mit WBS 100")
		expect(listing?.restrictions).toEqual({
			kind: "wbs-required",
			wbsLevels: [100],
			wbsSpecialNeed: null,
		})
	})

	test("recovers propertyId from the detail page for a senior-housing teaser with no bookmark id", async () => {
		const teasers = await loadTeasers(3)
		const senior = teasers[8]
		expect(senior.querySelector("[data-openimmo-bookmark-item-uid]")).toBeNull()
		const detailHtml = await loadFixtureText("detailSenior1.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))

		const listing = await degewo.extractListing(senior)

		expect(listing?.propertyId).toBe("W1100.00623.0002-0002")
		expect(listing?.title).toBe(
			"Seniorenresidenz Alt-Britz / Barrierefreie 1 Zimmer Wohnung, erst ab 60 Jahren",
		)
	})

	test("returns null and logs a warning when the detail-page recovery fetch fails too", async () => {
		const teasers = await loadTeasers(3)
		const senior = teasers[8]
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("network down")
		}) as unknown as typeof fetch)

		const listing = await degewo.extractListing(senior)

		expect(listing).toBeNull()
		expect(warnSpy).toHaveBeenCalled()
	})

	test("returns null and logs a warning when the address doesn't match the expected template, instead of throwing", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const root = parse(`
			<div class="c-teaser--apartment">
				<button data-openimmo-bookmark-item-uid="X1"></button>
				<h3><a href="/immosuche/details/x">Broken listing</a></h3>
				<p>this address has no pipe separator at all</p>
			</div>
		`)
		const teaser = root.querySelector(".c-teaser--apartment")
		if (!teaser) throw new Error("test markup missing")

		return degewo.extractListing(teaser).then((listing) => {
			expect(listing).toBeNull()
			expect(warnSpy).toHaveBeenCalled()
		})
	})
})

describe("Degewo.getListings", () => {
	afterEach(() => {
		mock.restore()
	})

	test("paginates all 7 real pages, recovering propertyIds for every senior-housing teaser, and dedupes", async () => {
		const pages = await Promise.all(
			[1, 2, 3, 4, 5, 6, 7].map((p) => loadFixtureText(`listPage${p}.html`)),
		)
		const seniorDetails: Record<string, string> = {
			"/immosuche/details/seniorenresidenz-alt-britz-barrierefreie-1-zimmer-wohnung-erst-ab-60-jahren":
				await loadFixtureText("detailSenior1.html"),
			"/immosuche/details/komfortables-wohnen-mit-service-fuer-senioren-1":
				await loadFixtureText("detailSenior2.html"),
			"/immosuche/details/3-zimmerwohnung-in-der-seniorenresidenz-koepenick":
				await loadFixtureText("detailSenior3.html"),
		}

		spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
			init?: RequestInit,
		) => {
			const href = String(url)
			if (href.endsWith("/immosuche")) {
				const body = String(init?.body)
				const match = body.match(/page%5D=(\d+)/)
				const pageNumber = match ? Number(match[1]) : 1
				return new Response(pages[pageNumber - 1])
			}
			for (const [path, html] of Object.entries(seniorDetails)) {
				if (href.endsWith(path)) return new Response(html)
			}
			throw new Error(`unexpected fetch: ${href}`)
		}) as unknown as typeof fetch)

		const listings = await degewo.getListings()

		// 68 raw teasers across all pages, but real fixture data: one
		// propertyId genuinely lands on two different pages
		expect(listings).toHaveLength(67)
		expect(new Set(listings.map((l) => l.propertyId)).size).toBe(67)
		expect(listings.some((l) => l.propertyId === "W1100.00623.0002-0002")).toBe(
			true,
		)
	})
})

describe("Degewo.backfill", () => {
	afterEach(() => {
		mock.restore()
	})

	test("fills costs, newBuilding and barrierFree from a real detail page", async () => {
		const detailHtml = await loadFixtureText("detailNormal.html")
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(detailHtml))
		const target = makeIncompleteListing()

		await degewo.backfill([target])

		expect(target.costs).toEqual({
			coldRentEur: 252.29,
			utilityEur: 104.94, // 62.20 (kalt) + 42.74 (warm)
			heatingEur: 42.74,
			depositEur: 756.87, // coldRentEur x 3, "Kaution" clause present
			totalRentEur: undefined,
		})
		expect(target.newBuilding).toBe(false) // Baujahr 1981
		expect(target.features).toEqual(["Aufzug", "Badewanne"])
		expect(target.accessibility?.barrierFree).toBe(false)
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
			accessibility: { barrierFree: false },
		})

		await degewo.backfill([complete])

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
			fullUrl: "https://www.degewo.de/immosuche/details/broken",
		})
		const healthy = makeIncompleteListing({
			propertyId: "healthy-id",
			fullUrl: "https://www.degewo.de/immosuche/details/healthy",
		})

		await degewo.backfill([broken, healthy])

		expect(broken.newBuilding).toBeUndefined()
		expect(healthy.newBuilding).toBe(false)
		expect(
			warnSpy.mock.calls.some((call) => String(call[0]).includes("broken-id")),
		).toBe(true)
	})
})
