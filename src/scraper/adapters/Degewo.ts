import parse, { type HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { restrictionFromTitle } from "../wbs"

const BASE_URL = "https://www.degewo.de"

export default class Degewo extends Scraper {
	constructor() {
		super("degewo")
	}

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("costs", () => this.backfillData(listings))
	}

	private async fetchDetailPageData(url: string): Promise<{
		detailData: Map<string, string>
		features: string[]
	}> {
		const html = await this.fetchHtml(url)

		const header = required(
			html.querySelector(".c-info-box"),
			"header with blue bg and two circles",
		)
		const headerDetailData = zipStrings(
			header.querySelectorAll("dt").map((item) => item.innerText.trim()),
			header.querySelectorAll("dd").map((item) => item.innerText.trim()),
		)

		const tables = required(
			html.querySelector("#section-def-list-rent-details"),
			"tables: kosten, objektdetails, energiedaten",
		)
		const tableDetailData = zipStrings(
			tables.querySelectorAll("dt").map((item) => item.innerText.trim()),
			tables.querySelectorAll("dd").map((item) => item.innerText.trim()),
		)

		const features = html
			.querySelectorAll(".c-tag__label")
			.map((elem) => elem.innerText.trim())

		return {
			detailData: new Map([...headerDetailData, ...tableDetailData]),
			features,
		}
	}

	private async backfillData(listings: ApartmentListing[]): Promise<void> {
		const listingTargets = listings.filter(
			(listing) =>
				listing.costs.depositEur === undefined ||
				listing.costs.coldRentEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.costs.heatingEur === undefined ||
				listing.newBuilding === undefined ||
				!listing.features ||
				listing.accessibility?.barrierFree === undefined,
		)

		await runConcurrent(listingTargets, this.concurrency, async (listing) => {
			try {
				const data = await this.fetchDetailPageData(listing.fullUrl)
				const details = data.detailData
				const coldRentEur = this.parseGermanFloatOrNull(
					details.get("Nettokaltmiete"),
				)
				const utilityColdEur = this.parseGermanFloatOrNull(
					details.get("Betriebskosten (kalt)"),
				)
				const utilityWarmEur = this.parseGermanFloatOrNull(
					details.get("Betriebskosten (warm)"),
				)
				const baujahr = details.get("Baujahr")

				listing.costs.coldRentEur = coldRentEur
				listing.costs.utilityEur =
					utilityColdEur === null || utilityWarmEur === null
						? null
						: utilityColdEur + utilityWarmEur
				listing.costs.heatingEur = utilityWarmEur
				listing.costs.depositEur =
					coldRentEur === null || !details.has("Kaution")
						? null
						: coldRentEur * 3
				listing.newBuilding =
					baujahr === undefined ? null : Number(baujahr) >= 2014
				listing.features = data.features
				listing.accessibility ??= {}
				listing.accessibility.barrierFree =
					data.features.findIndex((item) => item === "Barrierefrei") >= 0
			} catch (err) {
				log.warn(
					` -> Failed to backfill data for id ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	// Default order unstable, listing can land on two pages or none.
	// Sort by rent to mostly fix it. POST also skips TYPO3's cHash.
	private sessionCookie: string | undefined

	private async fetchPage(pageNumber: number): Promise<HTMLElement> {
		const sortParam =
			"tx_openimmo_immobilie%5BsortBy%5D=immobilie_preise_warmmiete"
		const body =
			pageNumber === 1
				? `tx_openimmo_immobilie%5Bsearch%5D=search&${sortParam}`
				: "tx_openimmo_immobilie%5Bsearch%5D=paginate&" +
					`tx_openimmo_immobilie%5Bpage%5D=${pageNumber}&${sortParam}`

		const { text, headers } = await this.fetchTextWithHeaders(
			`${BASE_URL}/immosuche`,
			{
				method: "POST",
				credentials: "omit",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
					"User-Agent":
						"Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
					...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
				},
				body,
			},
		)

		const setCookies = headers.getSetCookie()
		if (setCookies.length > 0) {
			this.sessionCookie = setCookies.map((c) => c.split(";")[0]).join("; ")
		}
		return parse(text)
	}

	// Senior-housing listings ("Wohnen mit Service") have no bookmark id on
	// teaser - recover it from the detail page instead.
	private async recoverPropertyIdFromDetailPage(
		url: string,
	): Promise<string | undefined> {
		try {
			const page = await this.fetchHtml(url)
			return (
				page
					.querySelector("[data-openimmo-bookmark-item-uid]")
					?.getAttribute("data-openimmo-bookmark-item-uid") ?? undefined
			)
		} catch (err) {
			log.warn(`degewo: failed to recover propertyId from ${url}: ${err}`)
			return undefined
		}
	}

	public async extractListing(
		teaser: HTMLElement,
	): Promise<ApartmentListing | null> {
		const linkHref = required(
			teaser.querySelector("h3 a"),
			"degewo teaser h3 link",
		).getAttribute("href")

		let propertyId = teaser
			.querySelector("[data-openimmo-bookmark-item-uid]")
			?.getAttribute("data-openimmo-bookmark-item-uid")
		if (!propertyId && linkHref) {
			propertyId = await this.recoverPropertyIdFromDetailPage(
				`${BASE_URL}${linkHref}`,
			)
		}
		if (!propertyId) {
			log.warn("degewo: couldn't extract propertyId, skipping")
			return null
		}

		const title = required(
			teaser.querySelector("h3"),
			"degewo teaser h3 title",
		).innerText.trim()
		const imageSrc = teaser.querySelector("figure img")?.getAttribute("src")
		const rawAddress = required(
			teaser.querySelector("p"),
			"degewo teaser address paragraph",
		)
			.innerText.trim()
			.replace(/ Aufgang \d+/, "")
		let street: string | undefined
		let houseNumber: string | undefined
		let precinct: string | undefined
		try {
			;({ street, houseNumber, precinct } = parseAddress(
				rawAddress,
				"{street} {houseNumber} &#124; {precinct}",
			))
		} catch (err) {
			log.warn(
				`degewo: couldn't parse address "${rawAddress}", skipping: ${err}`,
			)
			return null
		}
		if (!street || !houseNumber || !precinct) {
			log.warn(
				`degewo: address "${rawAddress}" missing expected fields, skipping`,
			)
			return null
		}
		const spaceQmText = required(
			teaser.querySelector("dl>div:nth-child(3)>dt"),
			"degewo teaser spaceQm cell",
		).textContent
		const roomsText = required(
			teaser.querySelector("dl>div:nth-child(2)>dt"),
			"degewo teaser rooms cell",
		).textContent
		const totalRentText = required(
			teaser.querySelector("dl>div:nth-child(1)>dt"),
			"degewo teaser totalRent cell",
		).textContent

		return {
			propertyId,
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: `${BASE_URL}${linkHref}`,
			location: {
				street,
				houseNumber,
				neighborhood: precinct,
				city: "Berlin",
			},
			spaceQm: this.parseGermanFloat(spaceQmText),
			rooms: this.parseGermanFloat(roomsText),
			restrictions: restrictionFromTitle(title),
			costs: {
				totalRentEur: this.parseGermanFloat(totalRentText),
			},
			images: imageSrc
				? [
						{
							fullUrl: `${BASE_URL}${imageSrc}`,
						},
					]
				: [],
		}
	}

	private async extractListings(
		root: HTMLElement,
	): Promise<ApartmentListing[]> {
		const teasers = root.querySelectorAll(".c-teaser--apartment")
		const listings = await runConcurrent(teasers, this.concurrency, (teaser) =>
			this.extractListing(teaser),
		)
		return listings.flatMap((listing) => listing ?? [])
	}

	private getDeclaredTotal(page1?: HTMLElement): number | undefined {
		const text = page1?.querySelector(".results-count")?.textContent
		const match = text?.match(/\d+/)
		return match ? parseInt(match[0], 10) : undefined
	}

	public async getListings(): Promise<ApartmentListing[]> {
		const MAX_RESULTS_PER_PAGE = 10
		let declaredTotal: number | undefined

		const pages = await this.paginateHtmlPages(
			(pageNumber) => this.fetchPage(pageNumber),
			(firstPage) => {
				declaredTotal = this.getDeclaredTotal(firstPage)
				return declaredTotal === undefined
					? 1
					: Math.ceil(declaredTotal / MAX_RESULTS_PER_PAGE)
			},
			// Page returned is session state, not a stateless signature -
			// concurrent requests on one session race each other.
			1,
		)

		const listingsPerPage = await Promise.all(
			pages.map((page) => this.extractListings(page)),
		)
		const deduped = this.dedupeByPropertyId(listingsPerPage.flat())

		if (declaredTotal !== undefined && deduped.length < declaredTotal) {
			log.warn(
				`degewo: captured ${deduped.length}/${declaredTotal} listings - some ` +
					"listings unreachable this run (site's own pagination has no full tiebreaker)",
			)
		}
		return deduped
	}
}
