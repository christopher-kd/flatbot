import type { ApartmentListing, ApartmentListingImage } from "../../types"
import Scraper from "../Scraper"
import type { HTMLElement } from "node-html-parser"
import { parseAddress } from "../util/address"
import { restrictionFromTitle } from "../wbs"
import { runConcurrent } from "../util/concurrency"
import { zipKeyValueText } from "../util/zip"
import log from "../../logger/logger"

export default class Gewobag extends Scraper {
	constructor() {
		super("Gewobag")
  }

  public async backfill(listings: ApartmentListing[]): Promise<void> {
    this.runBackfillStep("fill costs", () => this.backfillCosts(listings))
  }

  private async backfillCosts(listings: ApartmentListing[]) {
    const listingTargets = listings.filter(listing =>
      listing.costs.coldRentEur === 0 ||
      listing.costs.depositEur === 0 ||
      listing.costs.heatingEur === 0 ||
      listing.costs.utilityEur === 0
    )

    runConcurrent(listingTargets, this.concurrency, async listing => {
      try {
        const detailTable = await this.fetchDetailTable(listing.fullUrl)

        listing.costs.coldRentEur = this.parseGermanFloat(detailTable.get("Grundmiete") ?? "")
        listing.costs.depositEur = this.parseGermanFloat(detailTable.get("Kaution") ?? "")

        const utilityColdEur = this.parseGermanFloat(detailTable.get("VZ Betriebskosten kalt") ?? "")
        const utilityWarmEur = this.parseGermanFloat(detailTable.get("VZ Betriebskosten warm") ?? "")
        listing.costs.utilityEur = utilityColdEur + utilityWarmEur
        listing.costs.heatingEur = utilityWarmEur
      } catch (err) {
        log.warn(` -> Failed to backfill data for id ${listing.propertyId}: ${err}`)
      }
    })

  }

  private async fetchDetailTable(url: string): Promise<Map<string, string>> {
    const page = await this.fetchHtml(url)

    const keyElements = page.querySelectorAll("table:not(.details-characteristics) th")
      .map(elem => elem.innerText.trim())
    const valueElements = page.querySelectorAll("table:not(.details-characteristics) td")
      .map(elem => elem.innerText.trim())

    return zipKeyValueText(keyElements, valueElements)
  }

	private async fetchBody(page: number) {
		const searchParams = new URLSearchParams({
			"objekttyp[]": "wohnung",
			gesamtmiete_von: "",
			gesamtmiete_bis: "",
			gesamtflaeche_von: "",
			gesamtflaeche_bis: "",
			zimmer_von: "",
			zimmer_bis: "",
			"sort-by": "",
		})
		const url = new URL(
			"https://www.gewobag.de/fuer-mietinteressentinnen/" +
				`mietangebote/page/${page}/`,
		)
		url.search = searchParams.toString()
		return this.fetchHtml(url)
	}

	// TODO site has attributes for wbs
	private extractListing(listing: HTMLElement): ApartmentListing {
		const url = listing.querySelector(".angebot-footer a").getAttribute("href")
		const address = listing.querySelector("address").innerText.split("/")
		const district = address[1]
		const parsedAddress = parseAddress(
			address[0],
			"{street} {houseNumber}, {postalCode} {city}",
		)
		const roomAndQm = listing
			.querySelector(".angebot-area td")
			.innerText.trim()
			.split(" | ")
		const rooms = parseInt(roomAndQm[0].split(" ")[0], 10)
		const qm = this.parseGermanFloat(roomAndQm[1].split(" ")[0])
		const imgSrcs = listing.querySelectorAll("img").map((q) => {
			return {
				fullUrl: q.getAttribute("src"),
			} as ApartmentListingImage
		})
		const title = listing.querySelector("h3").textContent

		return {
			propertyId: new URL(url).pathname.split("/")[3],
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: url,
			location: {
				street: parsedAddress.street,
				postalCode: parsedAddress.postalCode,
				houseNumber: parsedAddress.houseNumber,
				city: parsedAddress.city,
				neighborhood: district,
			},
			spaceQm: qm,
			rooms,
			costs: {
				totalRentEur: this.parseGermanFloat(
					listing.querySelector(".angebot-kosten td").innerText.split(" ")[1],
				),
			},
			restrictions: restrictionFromTitle(title),
			images: imgSrcs,
		}
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		// ul.page-numbers a:not(.next) check if visible, if visible, check
		// last page number
		const pages = await this.paginateHtmlPages(
			(pageNumber) => this.fetchBody(pageNumber),
			(firstPage) => {
				const activePaginatorItems = firstPage.querySelectorAll(
					"ul.page-numbers a:not(.next)",
				)
				if (activePaginatorItems.length > 0) {
					return parseInt(activePaginatorItems.pop().innerText, 10)
				}
				return 1
			},
		)

		return pages.flatMap((page) =>
			page
				.querySelectorAll(".filtered-elements article")
				.map((listing) => this.extractListing(listing)),
		)
	}

}
