import parse, { type HTMLElement } from "node-html-parser"
import log from "../logger/logger"
import type { ApartmentListing, Organization } from "../types"
import { buildListingId } from "./listingId"
import { countDefinedFields } from "./merge"
import { runConcurrent } from "./util/concurrency"
import { parse as parse5Parse, serialize } from "parse5"

abstract class Scraper {
	#externalRequestsCount = 0
	public readonly organization: Organization
	protected concurrency = 6

	constructor(organization: Organization) {
		this.organization = organization
	}

	public getRequestCount(): number {
		return this.#externalRequestsCount
	}

	public async fetchListings(): Promise<ApartmentListing[]> {
		const listings = await this.getListings()
		for (const listing of listings) {
			listing.listingId = buildListingId(
				listing.organization,
				listing.propertyId,
			)
		}
		return listings
	}

	// Adapters override to hydrate fields the initial fetch misses.
	public async backfill(_listings: ApartmentListing[]): Promise<void> {}

	// Run one named backfill step, isolating failure from sibling steps.
	// Returns undefined (already logged) if throw - dependent callers
	// can check for that; independent steps just fire and ignore it.
	protected async runBackfillStep<T>(
		name: string,
		fn: () => Promise<T>,
	): Promise<T | undefined> {
		try {
			return await fn()
		} catch (err) {
			log.warn(`${this.organization} backfill step "${name}" failed: ${err}`)
			return undefined
		}
	}

	protected abstract getListings(): Promise<ApartmentListing[]>

	protected parseGermanFloat(value: string): number {
		return parseFloat(
			String(value)
				.replace(/[^\d.,-]/g, "")
				.replace(/\./g, "")
				.replace(",", "."),
		)
	}

	protected async fetchText(
		url: string | URL,
		init?: RequestInit,
	): Promise<string> {
		const res = await fetch(url, init)
		this.#externalRequestsCount++
		if (!res.ok) {
			throw new Error(
				`${this.organization} request to ${url} failed: ` +
					`${res.status} ${res.statusText}`,
			)
		}
		return res.text()
	}

	protected async fetchJson<T>(
		url: string | URL,
		init?: RequestInit,
	): Promise<T> {
		const res = await fetch(url, init)
		this.#externalRequestsCount++
		if (!res.ok) {
			throw new Error(
				`${this.organization} request to ${url} failed: ` +
					`${res.status} ${res.statusText}`,
			)
		}
		return res.json() as Promise<T>
	}

	protected async fetchHtml(
    url: string | URL,
		opts?: RequestInit & {sanitize?: boolean}
  ): Promise<HTMLElement> {
    const { sanitize, ...init } = opts ?? {}
    if (!sanitize) {
      return parse(await this.fetchText(url, init))
    }

    const rawHTML = await this.fetchText(url, init)
    const sanitized = serialize(parse5Parse(rawHTML))
    return parse(sanitized)
	}

	// For sites whose page 1 states the total page count up front, so the
	// rest can be fetched concurrently
	protected async paginateHtmlPages(
		fetchPage: (pageNumber: number) => Promise<HTMLElement>,
		getPageCount: (firstPage: HTMLElement) => number,
		concurrency = this.concurrency,
	): Promise<HTMLElement[]> {
		const firstPage = await fetchPage(1)
		const pageCount = getPageCount(firstPage)
		const remainingPageNumbers = Array.from(
			{ length: pageCount - 1 },
			(_, i) => i + 2,
		)
		const remainingPages = await runConcurrent(
			remainingPageNumbers,
			concurrency,
			fetchPage,
		)
		return [firstPage, ...remainingPages]
	}

	protected dedupeByPropertyId(
		listings: ApartmentListing[],
	): ApartmentListing[] {
		const byPropertyId = new Map<string, ApartmentListing>()
		for (const listing of listings) {
			const existing = byPropertyId.get(listing.propertyId)
			if (
				!existing ||
				countDefinedFields(listing) > countDefinedFields(existing)
			) {
				byPropertyId.set(listing.propertyId, listing)
			}
		}
		return [...byPropertyId.values()]
	}
}

export default Scraper
