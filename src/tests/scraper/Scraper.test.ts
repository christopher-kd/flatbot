import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import Scraper from "../../scraper/Scraper"
import type { ApartmentListing, Organization } from "../../types"

class TestScraper extends Scraper {
	public listings: ApartmentListing[] = []

	constructor(organization: Organization = "Berlinovo") {
		super(organization)
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		return this.listings
	}

	public callDedupeByPropertyId(listings: ApartmentListing[]) {
		return this.dedupeByPropertyId(listings)
	}

	public callParseGermanFloat(value: string): number {
		return this.parseGermanFloat(value)
	}

	public callFetchText(url: string | URL, init?: RequestInit): Promise<string> {
		return this.fetchText(url, init)
	}

	public callFetchJson<T>(url: string | URL, init?: RequestInit): Promise<T> {
		return this.fetchJson<T>(url, init)
	}

	public callPaginateHtmlPages(
		fetchPage: (pageNumber: number) => Promise<HTMLElement>,
		getPageCount: (firstPage: HTMLElement) => number,
		concurrency?: number,
	): Promise<HTMLElement[]> {
		return this.paginateHtmlPages(fetchPage, getPageCount, concurrency)
	}

	public callRunBackfillStep<T>(
		name: string,
		fn: () => Promise<T>,
	): Promise<T | undefined> {
		return this.runBackfillStep(name, fn)
	}
}

const scraper = new TestScraper()

function makePage(pageNumber: number): HTMLElement {
	return { pageNumber } as unknown as HTMLElement
}

function pageNumberOf(page: HTMLElement): number {
	return (page as unknown as { pageNumber: number }).pageNumber
}

async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve()
	}
}

// Page 1 resolves immediately (mirrors paginateHtmlPages awaiting it alone,
// before dispatch even starts); every other page waits for its resolver to
// be called manually, so tests can control dispatch/resolution order.
function makeControllableFetchPage() {
	const calls: number[] = []
	const resolvers = new Map<number, () => void>()
	const fetchPage = (pageNumber: number): Promise<HTMLElement> => {
		calls.push(pageNumber)
		if (pageNumber === 1) return Promise.resolve(makePage(1))
		return new Promise<HTMLElement>((resolve) => {
			resolvers.set(pageNumber, () => resolve(makePage(pageNumber)))
		})
	}
	return { calls, resolvers, fetchPage }
}

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
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
		costs: { totalRentEur: 500 },
		images: [],
		...overrides,
	}
}

describe("fetchListings", () => {
	test("listingId = organization:propertyId for direct scraper", async () => {
		const fake = new TestScraper("HOWOGE")
		fake.listings = [makeListing({ organization: "HOWOGE", propertyId: "123" })]
		const result = await fake.fetchListings()
		expect(result.map((l) => l.listingId)).toEqual(["HOWOGE:123"])
	})

	test("listingId uses each listing's own org, not scraper's org", async () => {
		// Simulates InBerlinWohnenScraper: its own organization is "inberlinwohnen",
		// but each listing it produces already carries the resolved direct
		// landlord's organization — listingId must use that per-listing value.
		const fake = new TestScraper("inberlinwohnen")
		fake.listings = [
			makeListing({ organization: "HOWOGE", propertyId: "111" }),
			makeListing({ organization: "WBM", propertyId: "222" }),
		]
		const result = await fake.fetchListings()
		expect(result.map((l) => l.listingId)).toEqual(["HOWOGE:111", "WBM:222"])
	})
})

describe("backfill", () => {
	test("default is a no-op that resolves undefined", async () => {
		const fresh = new TestScraper()
		const result = await fresh.backfill([makeListing()])
		expect(result).toBeUndefined()
	})

	test("default does not mutate the listings passed in", async () => {
		const fresh = new TestScraper()
		const original = makeListing({ title: "untouched" })
		const listings = [{ ...original }]
		await fresh.backfill(listings)
		expect(listings).toEqual([original])
	})
})

describe("runBackfillStep", () => {
	afterEach(() => {
		mock.restore()
	})

	test("returns fn's result on success", async () => {
		const fresh = new TestScraper()
		const result = await fresh.callRunBackfillStep("area", async () => 42)
		expect(result).toBe(42)
	})

	test("returns undefined and logs a warning when fn throws synchronously", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const fresh = new TestScraper("HOWOGE")

		const result = await fresh.callRunBackfillStep("area", () => {
			throw new Error("boom")
		})

		expect(result).toBeUndefined()
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const message = String(warnSpy.mock.calls[0]?.[0])
		expect(message).toContain("HOWOGE")
		expect(message).toContain("area")
		expect(message).toContain("boom")
	})

	test("returns undefined and logs a warning when fn's promise rejects", async () => {
		const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined)
		const fresh = new TestScraper("HOWOGE")

		const result = await fresh.callRunBackfillStep("area", async () => {
			throw new Error("boom")
		})

		expect(result).toBeUndefined()
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	test("a failed step does not affect a later step", async () => {
		spyOn(log, "warn").mockImplementation(() => undefined)
		const fresh = new TestScraper()

		const first = await fresh.callRunBackfillStep("a", async () => {
			throw new Error("fail")
		})
		const second = await fresh.callRunBackfillStep("b", async () => "ok")

		expect(first).toBeUndefined()
		expect(second).toBe("ok")
	})
})

describe("getRequestCount", () => {
	afterEach(() => {
		mock.restore()
	})

	test("starts at 0", () => {
		const fresh = new TestScraper()
		expect(fresh.getRequestCount()).toBe(0)
	})

	test("increments on fetchText", async () => {
		const fresh = new TestScraper()
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		await fresh.callFetchText("https://example.com")
		expect(fresh.getRequestCount()).toBe(1)
	})

	test("increments on fetchJson", async () => {
		const fresh = new TestScraper()
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ a: 1 })),
		)
		await fresh.callFetchJson("https://example.com")
		expect(fresh.getRequestCount()).toBe(1)
	})

	test("increments even when response not ok (fetchText throws)", async () => {
		const fresh = new TestScraper()
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("err", { status: 500, statusText: "Internal Server Error" }),
		)

		let error: unknown
		try {
			await fresh.callFetchText("https://example.com")
		} catch (err) {
			error = err
		}

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain("500")
		expect(fresh.getRequestCount()).toBe(1)
	})

	test("accumulates across multiple calls", async () => {
		const fresh = new TestScraper()
		spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response("ok")) as unknown as typeof fetch,
		)

		await fresh.callFetchText("https://example.com")
		await fresh.callFetchText("https://example.com")

		expect(fresh.getRequestCount()).toBe(2)
	})

	test("counter is per-instance, not shared", async () => {
		const a = new TestScraper()
		const b = new TestScraper()
		spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response("ok")) as unknown as typeof fetch,
		)

		await a.callFetchText("https://example.com")

		expect(a.getRequestCount()).toBe(1)
		expect(b.getRequestCount()).toBe(0)
	})
})

describe("paginateHtmlPages", () => {
	test("fetches only page 1 when there is a single page", async () => {
		const { calls, fetchPage } = makeControllableFetchPage()
		const fresh = new TestScraper()

		const result = await fresh.callPaginateHtmlPages(fetchPage, () => 1)

		expect(calls).toEqual([1])
		expect(result.map(pageNumberOf)).toEqual([1])
	})

	test("getPageCount receives the resolved first page", async () => {
		const firstPage = makePage(1)
		const fetchPage = async () => firstPage
		const getPageCount = mock((_firstPage: HTMLElement) => 1)
		const fresh = new TestScraper()

		await fresh.callPaginateHtmlPages(fetchPage, getPageCount)

		expect(getPageCount).toHaveBeenCalledTimes(1)
		expect(getPageCount.mock.calls[0][0]).toBe(firstPage)
	})

	test("fetches remaining pages and preserves order regardless of resolution order", async () => {
		const { resolvers, fetchPage } = makeControllableFetchPage()
		const fresh = new TestScraper()
		const resultPromise = fresh.callPaginateHtmlPages(fetchPage, () => 3, 5)

		await flushMicrotasks()
		// resolve out of numeric order — result order must still follow page number
		resolvers.get(3)?.()
		resolvers.get(2)?.()

		const result = await resultPromise
		expect(result.map(pageNumberOf)).toEqual([1, 2, 3])
	})

	test("never dispatches more than `concurrency` remaining pages at once", async () => {
		const { calls, resolvers, fetchPage } = makeControllableFetchPage()
		const fresh = new TestScraper()
		const resultPromise = fresh.callPaginateHtmlPages(fetchPage, () => 5, 2)

		await flushMicrotasks()
		expect(calls).toEqual([1, 2, 3]) // only pages 2 and 3 in flight

		resolvers.get(2)?.()
		await flushMicrotasks()
		expect(calls).toEqual([1, 2, 3, 4]) // slot freed, page 4 dispatched

		resolvers.get(3)?.()
		await flushMicrotasks()
		expect(calls).toEqual([1, 2, 3, 4, 5])

		resolvers.get(5)?.()
		resolvers.get(4)?.()
		const result = await resultPromise
		expect(result.map(pageNumberOf)).toEqual([1, 2, 3, 4, 5])
	})

	test("defaults concurrency to this.concurrency when not specified", async () => {
		const { calls, resolvers, fetchPage } = makeControllableFetchPage()
		const fresh = new TestScraper() // base Scraper's default `concurrency` is 6
		const resultPromise = fresh.callPaginateHtmlPages(fetchPage, () => 8)

		await flushMicrotasks()
		expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7]) // 6 remaining in flight, page 8 waits

		for (const pageNumber of [2, 3, 4, 5, 6, 7]) {
			resolvers.get(pageNumber)?.()
		}
		await flushMicrotasks()
		resolvers.get(8)?.()

		const result = await resultPromise
		expect(result.map(pageNumberOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
	})
})

describe("dedupeByPropertyId", () => {
	test("no duplicate items", () => {
		const listings = []
		for (let i = 1; i <= 5; i++) {
			listings.push(makeListing({ propertyId: String(i) }))
		}
		expect(scraper.callDedupeByPropertyId(listings).length).toBe(5)
	})

	test("one duplicate item", () => {
		const listings = [
			makeListing({ propertyId: "1" }),
			makeListing({ propertyId: "2" }),
			makeListing({ propertyId: "2" }),
		]
		expect(scraper.callDedupeByPropertyId(listings).length).toBe(2)
	})

	test("with equally complete duplicates, the first occurrence wins", () => {
		const listings = [
			makeListing({ propertyId: "1", title: "first" }),
			makeListing({ propertyId: "1", title: "second" }),
		]
		const result = scraper.callDedupeByPropertyId(listings)
		expect(result).toHaveLength(1)
		expect(result[0].title).toBe("first")
	})

	test("the more fuller duplicate wins, regardless of order", () => {
		const sparse = makeListing({ propertyId: "1", title: "sparse" })
		const rich = makeListing({
			propertyId: "1",
			title: "rich",
			location: {
				postalCode: "12345",
				city: "Berlin",
				street: "Teststr.",
				houseNumber: "1",
				neighborhood: "Mitte",
			},
		})

		const sparseFirst = scraper.callDedupeByPropertyId([sparse, rich])
		expect(sparseFirst).toHaveLength(1)
		expect(sparseFirst[0].title).toBe("rich")

		const richFirst = scraper.callDedupeByPropertyId([rich, sparse])
		expect(richFirst).toHaveLength(1)
		expect(richFirst[0].title).toBe("rich")
	})

	test("preserves original group order even when a later duplicate wins", () => {
		const listings = [
			makeListing({ propertyId: "1", title: "a" }),
			makeListing({ propertyId: "2", title: "sparse-b" }),
			makeListing({
				propertyId: "2",
				title: "rich-b",
				location: {
					postalCode: "12345",
					city: "Berlin",
					street: "Teststr.",
					houseNumber: "1",
					neighborhood: "Mitte",
				},
			}),
		]
		const result = scraper.callDedupeByPropertyId(listings)
		expect(result.map((l) => l.title)).toEqual(["a", "rich-b"])
	})

	test("all items are duplicates", () => {
		const listings = [
			makeListing({ propertyId: "3" }),
			makeListing({ propertyId: "3" }),
			makeListing({ propertyId: "3" }),
			makeListing({ propertyId: "3" }),
		]
		expect(scraper.callDedupeByPropertyId(listings).length).toBe(1)
	})

	test("empty listings", () => {
		expect(scraper.callDedupeByPropertyId([])).toEqual([])
	})
})

describe("parseGermanFloat", () => {
	test("decimal numbers with symbols", () => {
		expect(scraper.callParseGermanFloat("23.443.273,36 €")).toBe(23443273.36)
		expect(scraper.callParseGermanFloat("83,342 m²")).toBe(83.342)
		expect(scraper.callParseGermanFloat("2,5 Räume")).toBe(2.5)
		expect(scraper.callParseGermanFloat("2.373 €")).toBe(2373)
		expect(scraper.callParseGermanFloat("0,00")).toBe(0)
	})

	test("negative decimal numbers with symbols", () => {
		expect(scraper.callParseGermanFloat("-23.443.273,36 €")).toBe(-23443273.36)
		expect(scraper.callParseGermanFloat("-83,342 €")).toBe(-83.342)
		expect(scraper.callParseGermanFloat("-2,5 Räume")).toBe(-2.5)
		expect(scraper.callParseGermanFloat("-2.373 €")).toBe(-2373)
		expect(scraper.callParseGermanFloat("-0")).toBe(-0)
	})

	test("uncleanly parsed strings", () => {
		expect(scraper.callParseGermanFloat("\n-83,342 m²     \n")).toBe(-83.342)
		expect(scraper.callParseGermanFloat("\nKaution: 2633,37    \n")).toBe(
			2633.37,
		)
		expect(scraper.callParseGermanFloat("")).toBeNaN()
		expect(scraper.callParseGermanFloat("Ihre neue Wohnung")).toBeNaN()
	})
})
