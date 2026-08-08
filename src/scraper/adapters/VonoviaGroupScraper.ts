import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type {
	ApartmentListing,
	ApartmentListingImage,
	Organization,
} from "../../types"
import Scraper from "../Scraper"
import { runConcurrent } from "../util/concurrency"
import { delay } from "../util/delay"
import { zipStrings } from "../util/zip"
import type VonoviaGroupResponse from "./VonoviaGroup.types"

const EMPTY_RESULT_RETRIES = 5
const EMPTY_RESULT_RETRY_DELAY_MS = 4000

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

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		this.runBackfillStep("costs", () => this.backfillData(listings))
	}

	private async backfillData(listings: ApartmentListing[]): Promise<void> {
		const listingTargets = listings.filter(
			(listing) =>
				listing.costs.depositEur === undefined ||
				listing.costs.heatingEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.costs.totalRentEur === undefined ||
				listing.newBuilding === undefined ||
				!listing.features ||
				listing.accessibility?.barrierFree === undefined ||
				listing.accessibility?.senior === undefined,
		)

		await runConcurrent(listingTargets, 3, async (listing) => {
			try {
				const data = await this.fetchDetails(listing.fullUrl)
				const tableData = data.tableData
				const features = data.features
				const baujahr = tableData.get("Baujahr")

				const isX = (x: string, onFeatures: string[]): boolean => {
					x = x.toLowerCase()
					const items = onFeatures.map((feature) => feature.toLowerCase())
					for (const item of items) {
						if (item.includes(x)) return true
					}
					return false
				}

				listing.costs.depositEur = this.parseGermanFloatOrNull(
					tableData.get("Kaution"),
				)
				listing.costs.heatingEur = this.parseGermanFloatOrNull(
					tableData.get("Heizkosten"),
				)
				listing.costs.utilityEur = this.parseGermanFloatOrNull(
					tableData.get("Nebenkosten"),
				)
				listing.costs.totalRentEur = this.parseGermanFloatOrNull(
					tableData.get("Warmmiete"),
				)
				listing.newBuilding =
					baujahr === undefined ? null : Number(baujahr) >= 2014
				listing.features = features

				// "Barrierearmes Gebäude" exists as well, but is not checked for
				listing.accessibility ??= {}
				listing.accessibility.barrierFree = isX("barrierefrei", features)
				listing.accessibility.senior = isX("seniorengerecht", features)
			} catch (err) {
				log.warn(` -> Failed to backfill for id ${listing.propertyId}: ${err}`)
			}
		})
	}

	private async fetchDetails(
		url: string,
	): Promise<{ tableData: Map<string, string>; features: string[] }> {
		const page = await this.fetchHtml(url)

		const tables = page.querySelectorAll(".side-left .content-card ul")
		const keys: HTMLElement[] = []
		const values: HTMLElement[] = []
		for (const table of tables) {
			keys.push(...table.querySelectorAll(".name"))
			values.push(...table.querySelectorAll(".description"))
		}

		const tableData = zipStrings(
			keys.map((key) => key.text.trim()),
			values.map((value) => value.text.trim()),
		)

		const features = page
			.querySelectorAll(".equipment-list div")
			.map((elem) => elem.innerText.trim())

		return { tableData, features }
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

	private fetchListingsPage(offset?: number): Promise<VonoviaGroupResponse> {
		return this.fetchJson(this.buildUrl(offset))
	}

	// API sometimes returns an empty page - not just on the first page, any
	// of them. Retry each one, not just the first.
	private async fetchPageWithRetry(
		offset?: number,
	): Promise<VonoviaGroupResponse> {
		let lastResult: VonoviaGroupResponse | undefined
		for (let attempt = 1; attempt <= EMPTY_RESULT_RETRIES; attempt++) {
			lastResult = await this.fetchListingsPage(offset)
			if (lastResult.results.length > 0) return lastResult
			if (attempt < EMPTY_RESULT_RETRIES) {
				log.warn(
					`${this.organization}: got 0 results at offset ${offset ?? 0} ` +
						`(attempt ${attempt}/${EMPTY_RESULT_RETRIES}), retrying`,
				)
				await delay(EMPTY_RESULT_RETRY_DELAY_MS)
			}
		}
		return lastResult as VonoviaGroupResponse
	}

	private async fetchAllListings(): Promise<VonoviaGroupResponse["results"]> {
		const fetchResults: VonoviaGroupResponse[] = [
			await this.fetchPageWithRetry(),
		]
		const listingsCount = fetchResults[0].paging.info.count
		if (listingsCount <= 0)
			throw new Error("Couldn't find any listing. Blocked?")
		for (
			let offset = this.LISTING_LIMIT_PER_REQUEST;
			offset < listingsCount;
			offset += this.LISTING_LIMIT_PER_REQUEST
		) {
			fetchResults.push(await this.fetchPageWithRetry(offset))
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
		if (!listing.imageUrls.includes(listing.preview_img_url)) {
			images.push({ fullUrl: listing.preview_img_url })
		}
		return [
			{
				propertyId,
				organization: this.organization,
				lastSeenAt: Date.now(),
				title: listing.titel.trim(),
				fullUrl: `${this.listingUrlBase}${listing.slug}`,
				location: {
					street: street_raw.join(" "),
					houseNumber,
					city: city_raw[0],
					neighborhood: district,
					postalCode: listing.plz,
					// Not-yet-geocoded listings come back as 0,0 rather than
					// omitted - that's "null island", not a real location.
					coordinates:
						listing.lat === 0 && listing.lng === 0
							? null
							: { lat: listing.lat, lng: listing.lng },
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
