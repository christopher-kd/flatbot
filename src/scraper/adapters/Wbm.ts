import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { restrictionFromTitle } from "../wbs"

export default class WBM extends Scraper {
	constructor() {
		super("WBM")
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
			spaceQm: parseInt(
				required(
					listing.querySelector(".main-property-size"),
					"WBM listing .main-property-size",
				).textContent.split(" ")[0],
				10,
			),
			rooms: parseInt(
				required(
					listing.querySelector(".main-property-rooms"),
					"WBM listing .main-property-rooms",
				).textContent,
				10,
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
			images: imageSrc ? [{ fullUrl: imageSrc }] : [],
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
