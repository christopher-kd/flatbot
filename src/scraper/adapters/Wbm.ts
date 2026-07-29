import type { HTMLElement } from "node-html-parser"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
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
	private extractListing(listing: HTMLElement): ApartmentListing {
		const title = listing.querySelector("h2").textContent
		const parsedAddress = parseAddress(
			listing.querySelector(".address").textContent,
			"{street} {houseNumber}, {postalCode} {city}",
		)
		const href = listing.querySelector(".immo-button-cta").getAttribute("href")

		return {
			propertyId: listing.getAttribute("data-id"),
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: `https://wbm.de${href}`,
			location: {
				street: parsedAddress.street,
				postalCode: parsedAddress.postalCode,
				houseNumber: parsedAddress.houseNumber,
				city: parsedAddress.city,
				neighborhood: listing.querySelector(".area").textContent,
			},
			spaceQm: parseInt(
				listing.querySelector(".main-property-size").textContent.split(" ")[0],
				10,
			),
			rooms: parseInt(
				listing.querySelector(".main-property-rooms").textContent,
				10,
			),
			restrictions: {
				...restrictionFromTitle(title),
			},
			costs: {
				totalRentEur: this.parseGermanFloat(
					listing.querySelector(".main-property-rent").textContent,
				),
			},
			images: [
				{
					fullUrl: listing
						.querySelector(".imgWrap")
						.getAttribute("data-img-src"),
				},
			],
		}
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		// TODO what if there are multiple pages?? too few flwats to test :(
		const page = await this.fetchHtml(
			"https://www.wbm.de/wohnungen-berlin/angebote/",
		)
		const listings = page
			.querySelectorAll(".openimmo-search-list-item")
			.map((listing) => this.extractListing(listing))

		return this.dedupeByPropertyId(listings)
	}
}
