import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing, ApartmentListingImage } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { restrictionFromTitle } from "../wbs"

export default class Gewobag extends Scraper {
	constructor() {
		super("Gewobag")
	}

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("fill costs", () => this.backfillData(listings))
	}

	private async backfillData(listings: ApartmentListing[]) {
		const listingTargets = listings.filter(
			(listing) =>
				listing.costs.coldRentEur === undefined ||
				listing.costs.depositEur === undefined ||
				listing.costs.heatingEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.newBuilding === undefined ||
				!listing.features,
		)

		await runConcurrent(listingTargets, this.concurrency, async (listing) => {
			try {
				const details = await this.fetchDetailTable(listing.fullUrl)
				const map = details.map

				const beschreibung = map.get("Beschreibung")
				listing.newBuilding =
					beschreibung === undefined ? null : beschreibung === "Neubau"

				listing.costs.coldRentEur = this.parseGermanFloatOrNull(
					map.get("Grundmiete"),
				)
				listing.costs.depositEur = this.parseGermanFloatOrNull(
					map.get("Kaution"),
				)

				const utilityColdEur = this.parseGermanFloatOrNull(
					map.get("VZ Betriebskosten kalt"),
				)
				const utilityWarmEur = this.parseGermanFloatOrNull(
					map.get("VZ Betriebskosten warm"),
				)
				listing.costs.utilityEur =
					utilityColdEur === null || utilityWarmEur === null
						? null
						: utilityColdEur + utilityWarmEur
				listing.costs.heatingEur = utilityWarmEur
				listing.features = details.features
			} catch (err) {
				log.warn(
					` -> Failed to backfill data for id ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	private async fetchDetailTable(
		url: string,
	): Promise<{ map: Map<string, string>; features: string[] }> {
		const page = await this.fetchHtml(url)

		const tableSelector =
			"table:not(.details-characteristics):not(.details-further)"
		const keyElements = page
			.querySelectorAll(`${tableSelector} th`)
			.map((elem) => elem.innerText.trim())
		const valueElements = page
			.querySelectorAll(`${tableSelector} td`)
			.map((elem) => elem.innerText.trim())

		const features = page
			.querySelectorAll(".details-characteristics li")
			.map((elem) => elem.innerText.trim())

		return {
			map: zipStrings(keyElements, valueElements),
			features,
		}
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
	public extractListing(listing: HTMLElement): ApartmentListing {
		const url = required(
			required(
				listing.querySelector(".angebot-footer a"),
				"Gewobag listing .angebot-footer a",
			).getAttribute("href"),
			"Gewobag listing .angebot-footer a href",
		)
		const address = required(
			listing.querySelector("address"),
			"Gewobag listing address",
		).innerText.split("/")
		const district = address[1]
		const parsedAddress = parseAddress(
			address[0],
			"{street} {houseNumber}, {postalCode} {city}",
		)
		const street = required(parsedAddress.street, "Gewobag parsed street")
		const postalCode = required(
			parsedAddress.postalCode,
			"Gewobag parsed postalCode",
		)
		const houseNumber = required(
			parsedAddress.houseNumber,
			"Gewobag parsed houseNumber",
		)
		const city = required(parsedAddress.city, "Gewobag parsed city")

		const roomAndQm = required(
			listing.querySelector(".angebot-area td"),
			"Gewobag listing .angebot-area td",
		)
			.innerText.trim()
			.split(" | ")
		const rooms = this.parseGermanFloat(roomAndQm[0].split(" ")[0])
		const qm = this.parseGermanFloat(roomAndQm[1].split(" ")[0])
		const imgSrcs: ApartmentListingImage[] = listing
			.querySelectorAll("img")
			.flatMap((q) => {
				const src = q.getAttribute("src")
				return src ? [{ fullUrl: src }] : []
			})
		const title = required(
			listing.querySelector("h3"),
			"Gewobag listing h3",
		).textContent

		return {
			propertyId: new URL(url).pathname.split("/")[3],
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: url,
			location: {
				street,
				postalCode,
				houseNumber,
				city,
				neighborhood: district,
			},
			spaceQm: qm,
			rooms,
			costs: {
				totalRentEur: this.parseGermanFloat(
					required(
						listing.querySelector(".angebot-kosten td"),
						"Gewobag listing .angebot-kosten td",
					).innerText.split(" ")[1],
				),
			},
			restrictions: restrictionFromTitle(title),
			images: imgSrcs,
		}
	}

	public async getListings(): Promise<ApartmentListing[]> {
		// ul.page-numbers a:not(.next) check if visible, if visible, check
		// last page number
		const pages = await this.paginateHtmlPages(
			(pageNumber) => this.fetchBody(pageNumber),
			(firstPage) => {
				const activePaginatorItems = firstPage.querySelectorAll(
					"ul.page-numbers a:not(.next)",
				)
				if (activePaginatorItems.length > 0) {
					return parseInt(
						required(activePaginatorItems.pop(), "Gewobag pagination item")
							.innerText,
						10,
					)
				}
				return 1
			},
		)

		return pages.flatMap((page) =>
			page.querySelectorAll(".filtered-elements article").flatMap((listing) => {
				try {
					return [this.extractListing(listing)]
				} catch (err) {
					log.warn(`Gewobag: failed to extract listing: ${err}`)
					return []
				}
			}),
		)
	}
}
