import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { restrictionFromTitle } from "../wbs"

export default class WBM extends Scraper {
	constructor() {
		super("WBM")
	}

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("costs and is new building", () =>
			this.backfillData(listings),
		)
	}

	private async backfillData(listings: ApartmentListing[]): Promise<void> {
		const targets = listings.filter(
			(listing) =>
				listing.costs.coldRentEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.costs.totalRentEur === undefined ||
				listing.costs.depositEur === undefined ||
				listing.costs.heatingEur === undefined ||
				listing.newBuilding === undefined,
		)
		await runConcurrent(targets, this.concurrency, async (listing) => {
			try {
				const page = await this.fetchHtml(listing.fullUrl)
				const map = zipStrings(
					page
						.querySelectorAll(".openimmo-detail__rental-costs-list-item-title")
						.map((elem) => elem.textContent.trim()),
					page
						.querySelectorAll(".openimmo-detail__rental-costs-list-item-value")
						.map((elem) => elem.textContent.trim()),
				)

				const coldRentEur = this.parseGermanFloatOrNull(
					map.get("Nettokaltmiete"),
				)
				listing.costs.coldRentEur = coldRentEur
				listing.costs.utilityEur = this.parseGermanFloatOrNull(
					map.get("Nebenkosten"),
				)
				listing.costs.totalRentEur = this.parseGermanFloatOrNull(
					map.get("Warmmiete"),
				)
				listing.costs.depositEur = coldRentEur === null ? null : coldRentEur * 3
				listing.costs.heatingEur = null

				const baujahr = page
					.querySelectorAll(".openimmo-detail__energy-indicators-list-item")
					.find(
						(item) =>
							item.querySelector("span")?.textContent.trim() === "Baujahr:",
					)
					?.textContent.replace("Baujahr:", "")
					.trim()
				listing.newBuilding =
					baujahr === undefined ? null : Number(baujahr) >= 2014
			} catch (err) {
				log.warn(
					` -> Failed to backfill costs for id ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	// .openimmo-search-list-item -> listing
	// .openimmo-search-list-item h2 -> title
	// .openimmo-search-list-item .address -> address
	// .openimmo-search-list-item .main-property-rent -> total rent
	// .openimmo-search-list-item .main-property-size -> qm
	// .openimmo-search-list-item .main-property-rooms -> room count
	// .openimmo-search-list-item .check-property-list li -> features []
	// .openimmo-search-list-item .imgWrap -> src in prop [data-img-src]
	// .openimmo-search-list-item .area -> district / area
	// .openimmo-search-list-item .immo-button-cta -> detail page href
	private extractListing(listing: HTMLElement): ApartmentListing | null {
		const propertyId = listing.getAttribute("data-id")
		if (!propertyId) {
			log.warn("WBM: couldn't extract propertyId, skipping")
			return null
		}

		const title = required(
			listing.querySelector("h2"),
			"WBM listing h2",
		).textContent
		const parsedAddress = parseAddress(
			required(listing.querySelector(".address"), "WBM listing .address")
				.textContent,
			"{street} {houseNumber}, {postalCode} {city}",
		)
		const street = required(parsedAddress.street, "WBM parsed street")
		const postalCode = required(
			parsedAddress.postalCode,
			"WBM parsed postalCode",
		)
		const houseNumber = required(
			parsedAddress.houseNumber,
			"WBM parsed houseNumber",
		)
		const city = required(parsedAddress.city, "WBM parsed city")
		const href = required(
			listing.querySelector(".immo-button-cta"),
			"WBM listing .immo-button-cta",
		).getAttribute("href")
		const imageSrc = listing
			.querySelector(".imgWrap")
			?.getAttribute("data-img-src")

		return {
			propertyId,
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: `https://wbm.de${href}`,
			location: {
				street,
				postalCode,
				houseNumber,
				city,
				neighborhood: required(
					listing.querySelector(".area"),
					"WBM listing .area",
				).textContent,
			},
			spaceQm: this.parseGermanFloat(
				required(
					listing.querySelector(".main-property-size"),
					"WBM listing .main-property-size",
				).textContent,
			),
			rooms: this.parseGermanFloat(
				required(
					listing.querySelector(".main-property-rooms"),
					"WBM listing .main-property-rooms",
				).textContent,
			),
			restrictions: {
				...restrictionFromTitle(title),
			},
			costs: {
				totalRentEur: this.parseGermanFloat(
					required(
						listing.querySelector(".main-property-rent"),
						"WBM listing .main-property-rent",
					).textContent,
				),
			},
			images: imageSrc ? [{ fullUrl: `https://wbm.de${imageSrc}` }] : [],
		}
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		// TODO what if there are multiple pages?? too few flwats to test :(
		const page = await this.fetchHtml(
			"https://www.wbm.de/wohnungen-berlin/angebote/",
		)
		const listings = page
			.querySelectorAll(".openimmo-search-list-item")
			.flatMap((listing) => this.extractListing(listing) ?? [])

		return this.dedupeByPropertyId(listings)
	}
}
