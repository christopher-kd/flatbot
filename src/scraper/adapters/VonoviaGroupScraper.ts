import log from "../../logger/logger"
import type {
	ApartmentListing,
	ApartmentListingImage,
	Organization,
} from "../../types"
import Scraper from "../Scraper"
import type VonoviaGroupResponse from "./VonoviaGroup.types"

/**
 * Vonovia & Deutsche Wohnen run on the same listing API.
 */
export default abstract class VonoviaGroupScraper extends Scraper {
	private readonly LISTING_LIMIT_PER_REQUEST = 15

	constructor(
		organization: Organization,
		private readonly apiUrl: string,
		private readonly listingUrlBase: string,
	) {
		super(organization)
	}

	private buildUrl(offset?: number): string {
		const params = {
			limit: String(this.LISTING_LIMIT_PER_REQUEST),
			rentType: "miete",
			city: "Berlin",
			minRooms: "Beliebig",
			floor: "Beliebig",
			disabilityAccess: "egal",
			balcony: "egal",
			subsidizedHousingPermit: "egal",
			locationDisplay: "Berlin",
			immoType: "wohnung",
		}
		const urlParams = new URLSearchParams(params).toString()
		return `${this.apiUrl}?${urlParams}${offset ? `&offset=${offset}` : ""}`
	}

	private async fetchAllListings(): Promise<VonoviaGroupResponse["results"]> {
		const fetchResults: VonoviaGroupResponse[] = [
			await this.fetchJson(this.buildUrl()),
		]
		const listingsCount = fetchResults[0].paging.info.count
		if (listingsCount <= 0)
			throw new Error("Couldn't find any listing. Blocked?")
		for (
			let offset = this.LISTING_LIMIT_PER_REQUEST;
			offset < listingsCount;
			offset += this.LISTING_LIMIT_PER_REQUEST
		) {
			fetchResults.push(await this.fetchJson(this.buildUrl(offset)))
		}
		return fetchResults.flatMap((f) => f.results)
	}

	private extractListing(
		listing: VonoviaGroupResponse["results"][number],
	): ApartmentListing[] {
		const street_raw = listing.strasse.split(" ")
		const houseNumber = street_raw.pop() ?? ""
		// "OT" (Ortsteil) isn't always present in `ort` — only treat the last
		// segment as a district if the split actually found one, otherwise
		// city_raw.pop() would empty the array and leave city_raw[0] undefined.
		const city_raw = listing.ort.split(" OT ")
		const district = city_raw.length > 1 ? city_raw.pop() : undefined
		const propertyIdMatch = listing.slug.match(/\d{2}-\d{6,}/)
		if (!propertyIdMatch) {
			log.warn(`${this.organization}: couldn't extract propertyId, skipping`)
			return []
		}
		const propertyId = propertyIdMatch[0]
		const images: ApartmentListingImage[] = listing.imageUrls.map((url) => {
			return {
				fullUrl: url,
			}
		})
		images.push({ fullUrl: listing.preview_img_url })
		return [
			{
				propertyId,
				organization: this.organization,
				lastSeenAt: Date.now(),
				title: listing.titel,
				fullUrl: `${this.listingUrlBase}${listing.slug}`,
				location: {
					street: street_raw.join(" "),
					houseNumber,
					city: city_raw[0],
					neighborhood: district,
					postalCode: listing.plz,
					coordinates: {
						lat: listing.lat,
						lng: listing.lng,
					},
				},
				spaceQm: listing.groesse,
				rooms: listing.anzahl_zimmer,
				restrictions: null,
				costs: {
					coldRentEur: listing.preis,
				},
				images,
			},
		]
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		const listings = await this.fetchAllListings()
		return listings.flatMap((listing) => this.extractListing(listing))
	}
}
