import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing, ApartmentListingImage } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
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

	private parsePeriodFloatOrNull(value: string | undefined): number | null {
		if (value === undefined) return null
		const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ""))
		return Number.isNaN(parsed) ? null : parsed
	}

	public async fetchDetails(url: string): Promise<{
		map: Map<string, string>
		features: string[]
		descriptionText: string
		unitFeaturesText: string
		depositClauseText: string
	}> {
		const page = await this.fetchHtml(url, { sanitize: true })

		const details = required(
			page.querySelector(".details"),
			"details, right sidebar",
		)

		const features = page
			.querySelectorAll(".details [class*='has'].block:not(.null-as-empty)")
			.map((elem) => elem.textContent.trim())

		// No structured accessibility field exists on this site - only prose
		// mentions in these two blocks. Scoped to them (not the whole page) so
		// the sitewide footer nav link "Barrierefreiheit" can't false-positive
		// match on every single listing.
		const descriptionText = page
			.querySelectorAll(
				".field--name-field-description, .field--name-field-interior2",
			)
			.map((elem) => elem.textContent)
			.join(" ")

		// field-interior2 only, not field-description - that one's building-
		// wide ("some units here are wheelchair-friendly" on every unit's
		// page), too unreliable for a per-unit wheelchair claim.
		const unitFeaturesText = page
			.querySelectorAll(".field--name-field-interior2")
			.map((elem) => elem.textContent)
			.join(" ")

		// "3 Nettokaltmieten Kaution" is standard-listing boilerplate here, not
		// a site-wide constant - senior/service units routinely omit it
		// entirely (checked live: 3/3 sampled had no deposit clause anywhere
		// on the page), so *3 isn't a safe default for them.
		const depositClauseText = page
			.querySelectorAll(".field--name-field-otherinfo")
			.map((elem) => elem.textContent)
			.join(" ")

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
			descriptionText,
			unitFeaturesText,
			depositClauseText,
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
				listing.spaceQm === undefined ||
				listing.costs.totalRentEur === undefined ||
				listing.costs.coldRentEur === undefined ||
				listing.costs.depositEur === undefined ||
				listing.costs.heatingEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.newBuilding === undefined ||
				!listing.features ||
				listing.accessibility?.barrierFree === undefined,
		)

		await runConcurrent(listingTargets, this.concurrency, async (listing) => {
			try {
				// extract path due to failed redirects when link doesn't contain subdomain "www"
				const url = new URL(listing.fullUrl)
				const details = await this.fetchDetails(
					`https://www.berlinovo.de/de${url.pathname}`,
				)
				const map = details.map

				const baujahr = map.get("Baujahr")
				listing.newBuilding =
					baujahr === undefined ? null : Number(baujahr) >= 2014

				listing.costs.coldRentEur = this.parseGermanFloatOrNull(
					map.get("Kaltmiete"),
				)

				// This uses period decimal separator for some reason
				const bruttogesamtmiete = map.get("Bruttogesamtmiete")
				listing.costs.totalRentEur =
					this.parsePeriodFloatOrNull(bruttogesamtmiete)

				// Apply the *3 formula when page's own text confirms it -
				// senior/service units don't state a deposit clause at all
				listing.costs.depositEur =
					listing.costs.coldRentEur === null ||
					!/kaution/i.test(details.depositClauseText)
						? null
						: listing.costs.coldRentEur * 3

				// This also uses period decimal separator for some reason
				const heizkosten = map.get("Heizkosten")
				listing.costs.heatingEur = this.parsePeriodFloatOrNull(heizkosten)

				// These do not use the period decimal separator
				listing.costs.utilityEur = this.parseGermanFloatOrNull(
					map.get("Nebenkosten"),
				)
				listing.spaceQm = this.parseGermanFloatOrNull(map.get("Wohnfläche"))

				listing.features = details.features

				// No structured accessibility field on this site - only a
				// positive-match heuristic is reliable (absence of the word
				// doesn't mean the unit isn't barrier-free). "barrierearm"
				// (reduced barriers) is NOT the same claim as "barrierefrei"
				// (fully accessible) - don't match on it.
				listing.accessibility = {
					...listing.accessibility,
					barrierFree: /barrierefrei/i.test(
						`${listing.title} ${details.descriptionText}`,
					)
						? true
						: null,
					// wheelchair isn't tri-state - no match leaves it as-is,
					// doesn't assert false.
					...(/rollstuhl/i.test(details.unitFeaturesText)
						? { wheelchair: true }
						: {}),
				}
			} catch (err) {
				log.warn(
					` -> Failed to backfill data for id ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	public extractListing(listing: HTMLElement): ApartmentListing {
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

		const imageSrc = img?.getAttribute("src")
		const image: ApartmentListingImage | null = imageSrc
			? { fullUrl: `https://berlinovo.de${imageSrc}` }
			: null

		// could be missing from listing item
		const totalRentElem = listing.querySelector(
			".field--name-field-total-rent div[content]",
		)
		const totalRentEur = totalRentElem
			? this.parseGermanFloat(totalRentElem.textContent)
			: undefined

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

	public async getListings(): Promise<ApartmentListing[]> {
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
			page.querySelectorAll(".view article").flatMap((listing) => {
				try {
					return [this.extractListing(listing)]
				} catch (err) {
					log.warn(`Berlinovo: failed to extract listing: ${err}`)
					return []
				}
			}),
		)

		return this.dedupeByPropertyId(listings)
	}
}
