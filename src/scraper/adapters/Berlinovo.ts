import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing, ApartmentListingImage } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { delay } from "../util/delay"
import { zipStrings } from "../util/zip"
import { classifyRestriction, getSpecialNeed, getWbsLevels } from "../wbs"

export default class Berlinovo extends Scraper {
	constructor() {
		super("Berlinovo")
	}

	private async fetchPage(pageNumber: number) {
		return await this.fetchHtml(
			`https://www.berlinovo.de/de/wohnungen/suche?page=${pageNumber - 1}`,
		)
	}

	public async fetchArea(propertyId: string): Promise<number | null> {
		const page = await this.fetchHtml(
			`https://www.berlinovo.de/de/wohnung-id/${propertyId}`,
		)
		const areaElem = page.querySelector(
			".block-field-blocknodeapartmentfield-net-area .field__item",
		)
		if (!areaElem) return null
		await delay(250)
		return this.parseGermanFloat(areaElem.textContent.trim())
	}

	public async fetchDetails(
		url: string,
	): Promise<{ map: Map<string, string>; features: string[] }> {
		const page = await this.fetchHtml(url, { sanitize: true })

		const details = required(
			page.querySelector(".details"),
			"details, right sidebar",
		)

		const features = page
			.querySelectorAll(".details [class*='has'].block:not(.null-as-empty)")
			.map((elem) => elem.textContent.trim())

		return {
			map: zipStrings(
				details
					.querySelectorAll(".content .field .field__label")
					.map((e) => e.textContent.trim()),
				details
					.querySelectorAll(".content .field .field__item")
					.map((e) => e.textContent.trim()),
			),
			features,
		}
	}

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("area and costs", () =>
			this.backfillData(listings),
		)
	}

	private async backfillData(listings: ApartmentListing[]): Promise<void> {
		const listingTargets = listings.filter(
			(listing) =>
				!listing.spaceQm ||
				(listing.costs.totalRentEur ?? -1) <= 0 ||
				listing.costs.coldRentEur === 0 ||
				listing.costs.depositEur === 0 ||
				listing.costs.heatingEur === 0 ||
				listing.costs.utilityEur === 0 ||
				!listing.newBuilding ||
				!listing.features,
		)

		await runConcurrent(listingTargets, this.concurrency, async (listing) => {
			try {
				// extract path due to failed redirects when link doesn't contain subdomain "www"
				const url = new URL(listing.fullUrl)
				const details = await this.fetchDetails(
					`https://www.berlinovo.de/de${url.pathname}`,
				)
				const map = details.map

				const yearBuilt = Number(map.get("Baujahr") ?? "")
				listing.newBuilding = yearBuilt >= 2014

				listing.costs.coldRentEur = this.parseGermanFloat(
					map.get("Kaltmiete") ?? "",
				)

				// This uses period decimal separator for some reason
				listing.costs.totalRentEur = Number(
					required(map.get("Bruttogesamtmiete"), "Bruttogesamtmiete").slice(
						0,
						-2,
					),
				)

				// TODO: is this really always * 3?
				listing.costs.depositEur = listing.costs.coldRentEur * 3

				// This also uses period decimal separator for some reason
				listing.costs.heatingEur = Number(
					required(map.get("Heizkosten"), "Heizkosten").slice(0, -2),
				)

				// These do not use the period decimal separator
				listing.costs.utilityEur = this.parseGermanFloat(
					map.get("Nebenkosten") ?? "",
				)
				listing.spaceQm = this.parseGermanFloat(map.get("Wohnfläche") ?? "")

				listing.features = details.features
			} catch (err) {
				log.warn(
					` -> Failed to backfill data for id ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	private extractListing(listing: HTMLElement): ApartmentListing {
		const title = required(
			listing.querySelector(".title a"),
			"Berlinovo listing .title a",
		)
		const href = required(
			title.getAttribute("href"),
			"Berlinovo listing title link href",
		)
		const img = listing.querySelector("img")
		const wbsRequired = (() => {
			const sel = listing.querySelectorAll(
				".block-field-blocknodeapartmentfield-wbs" +
					"[data-null-as-empty]:not(.null-as-empty)",
			)
			return sel.length > 0
		})()
		const addressLine = required(
			listing.querySelector(".address-line1")?.textContent,
			"Berlinovo listing .address-line1",
		)
		const streetxNr = parseAddress(
			addressLine.split(",")[0],
			"{street} {houseNumber}",
		)

		const imageHref = img?.getAttribute("href")
		const image: ApartmentListingImage | null = imageHref
			? { fullUrl: imageHref }
			: null

		// could be missing from listing item
		const totalRentElem = listing.querySelector(
			".field--name-field-total-rent div[content]",
		)
		const totalRentEur = totalRentElem
			? this.parseGermanFloat(totalRentElem.textContent)
			: -1

		const restriction = wbsRequired
			? "wbs-required"
			: classifyRestriction(title.textContent).restriction
		const wbsLevels = getWbsLevels(title.textContent)
		const wbsSpecialNeed = getSpecialNeed(title.textContent)

		return {
			propertyId: href.split("/")[2],
			organization: this.organization,
			lastSeenAt: Date.now(),
			title: title.textContent,
			fullUrl: `https://berlinovo.de${href}`,
			location: {
				city: required(
					listing.querySelector(".locality")?.textContent,
					"Berlinovo listing .locality",
				),
				postalCode: required(
					listing.querySelector(".postal-code")?.textContent,
					"Berlinovo listing .postal-code",
				),
				street: required(streetxNr.street, "Berlinovo listing street (parsed)"),
				houseNumber: required(
					streetxNr.houseNumber,
					"Berlinovo listing houseNumber (parsed)",
				),
			},
			// filled by backfill() - not present at scrape time
			spaceQm: undefined,
			rooms: this.parseGermanFloat(
				required(
					listing.querySelector(
						".block-field-blocknodeapartmentfield-rooms div[content]",
					),
					"Berlinovo listing rooms cell",
				).textContent,
			),
			restrictions:
				restriction === "free"
					? { kind: "free" }
					: restriction === "income-checked"
						? { kind: "income-checked", wbsLevels }
						: { kind: "wbs-required", wbsLevels, wbsSpecialNeed },
			costs: {
				totalRentEur,
			},
			images: image ? [image] : [],
		}
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		// .source-summary-count --> results count, only present/read on page 1
		// .block-field-blocknodeapartmentfield-net-area .field__item -->
		//   quadratmeter auf detail page
		const MAX_RESULTS_PER_PAGE = 10
		const pages = await this.paginateHtmlPages(
			(pageNumber) => this.fetchPage(pageNumber),
			(firstPage) => {
				const summaryText = required(
					firstPage.querySelector(".source-summary-count"),
					"Berlinovo .source-summary-count",
				).textContent
				const countMatch = required(
					summaryText.match(/\d{1,}/),
					"Berlinovo results count digits",
				)
				const listingsCount = parseInt(countMatch[0], 10)
				let pageCount = Math.floor(listingsCount / MAX_RESULTS_PER_PAGE)
				if (listingsCount % MAX_RESULTS_PER_PAGE > 0) pageCount += 1
				return pageCount
			},
			4,
		)

		const listings = pages.flatMap((page) =>
			page
				.querySelectorAll(".view article")
				.map((listing) => this.extractListing(listing)),
		)

		return this.dedupeByPropertyId(listings)
	}
}
