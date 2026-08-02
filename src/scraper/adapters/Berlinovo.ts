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


  public async fetchDetails(url: string): Promise<Map<string, string>> {
    const page = await this.fetchHtml(url, { sanitize: true })

    const details = required(
      page.querySelector(".details"),
      "details, right sidebar"
    )
    return zipStrings(
      details.querySelectorAll(".content .field .field__label").map(e => e.textContent.trim()),
      details.querySelectorAll(".content .field .field__item").map(e => e.textContent.trim()),
    )
  }

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("area and costs", () => this.backfillData(listings))
	}

	private async backfillData(listings: ApartmentListing[]): Promise<void> {
    const listingTargets = listings.filter((listing) =>
      !listing.spaceQm ||
      listing.costs.coldRentEur === 0 ||
      listing.costs.depositEur === 0 ||
      listing.costs.heatingEur === 0 ||
      listing.costs.utilityEur === 0
    )

		await runConcurrent(listingTargets, this.concurrency, async (listing) => {
      try {
        // extract path due to failed redirects when link doesn't contain subdomain "www"
        const url = new URL(listing.fullUrl)
        const details = await this.fetchDetails(`https://www.berlinovo.de/de${url.pathname}`)

        listing.costs.coldRentEur = this.parseGermanFloat(details.get("Kaltmiete") ?? "")

        // TODO: is this really always * 3?
        listing.costs.depositEur = listing.costs.coldRentEur * 3

        // Heizkosten uses period decimal separator for some reason
        listing.costs.heatingEur = Number(
          required(details.get("Heizkosten"), "Heizkosten").slice(0, -2),
        )
        listing.costs.utilityEur = this.parseGermanFloat(details.get("Nebenkosten") ?? "")
        listing.spaceQm = this.parseGermanFloat(details.get("Wohnfläche") ?? "")
			} catch (err) {
				log.warn(
					` -> Failed to backfill data for id ${listing.propertyId}: ${err}`,
        )
			}
		})
	}

	private extractListing(listing: HTMLElement): ApartmentListing {
		const title = listing.querySelector(".title a")
    const href = title.getAttribute("href")
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
    const streetxNr = parseAddress(addressLine.split(',')[0], "{street} {houseNumber}")

    const image: ApartmentListingImage | null = (() => {
      if (img) {
        return {
          fullUrl: img.getAttribute('href')
        } as ApartmentListingImage
      }
      return null
    })()

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
			spaceQm: null,
			rooms: this.parseGermanFloat(
				listing.querySelector(
					".block-field-blocknodeapartmentfield-rooms div[content]",
				).textContent,
			),
			restrictions: {
				kind: wbsRequired
					? "wbs-required"
					: classifyRestriction(title.textContent).restriction,
				wbsLevels: getWbsLevels(title.textContent),
				wbsSpecialNeed: getSpecialNeed(title.textContent),
			},
			costs: {
				totalRentEur: this.parseGermanFloat(
					listing.querySelector(".field--name-field-total-rent div[content]")
						.textContent,
				),
			},
			images: image ? [image] : []
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
				const listingsCount = parseInt(
					firstPage
						.querySelector(".source-summary-count")
						.textContent.match(/\d{1,}/)[0],
					10,
				)
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
