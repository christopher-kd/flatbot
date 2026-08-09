import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type {
	ApartmentListing,
	ApartmentListingImage,
	Restrictions,
} from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { getSpecialNeed, getWbsLevels, restrictionFromTitle } from "../wbs"
import type HowogeResponse from "./Howoge.types"

const ATTR_RENT = ".attributes>div:nth-child(1) .attributes-content"
const ATTR_SPACE = ".attributes>div:nth-child(2) .attributes-content"
const ATTR_ROOMS = ".attributes>div:nth-child(3) .attributes-content"

// Derived from ApartmentListing, not hand-duplicated, so schema changes
// can't silently drift. Overrides below exist for raw coercion, costs
// flattening, and defaulting in toListing.
type ToListingParams = Omit<
	ApartmentListing,
	| "listingId"
	| "organization"
	| "lastSeenAt"
	| "costs"
	| "spaceQm"
	| "rooms"
	| "restrictions"
	| "images"
> & {
	spaceQm: string | number
	rooms: string | number
	totalRentEur: number
	restrictions?: Restrictions
	images?: ApartmentListingImage[]
}

class Howoge extends Scraper {
	constructor() {
		super("HOWOGE")
	}

	public async fetchDetailTable(
		propertyId: string,
	): Promise<{ map: Map<string, string>; features: string[] }> {
		const html = await this.fetchHtml(
			"https://www.howoge.de/immobiliensuche/wohnungssuche/detail/" +
				`${propertyId}.html`,
		)
		const keys = []
		const values = []
		for (const table of html.querySelectorAll(".section table")) {
			keys.push(
				...table
					.querySelectorAll("th")
					.map((th) => th.textContent.trim().slice(0, -1)),
			)
			values.push(
				...table.querySelectorAll("td").map((td) => td.textContent.trim()),
			)
		}

		const features = html
			.querySelectorAll(".features li")
			.map((elem) => elem.innerText.trim())
		return {
			map: zipStrings(keys, values),
			features,
		}
	}

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("costs and is new building", () =>
			this.backfillWithDetailTable(listings),
		)
	}

	private async backfillWithDetailTable(
		listings: ApartmentListing[],
	): Promise<void> {
		const targets = listings.filter(
			(listing) =>
				listing.newBuilding === undefined ||
				listing.costs.coldRentEur === undefined ||
				listing.costs.depositEur === undefined ||
				listing.costs.totalRentEur === undefined ||
				listing.costs.utilityEur === undefined ||
				listing.costs.heatingEur === undefined ||
				!listing.features,
		)
		await runConcurrent(targets, this.concurrency, async (listing) => {
			try {
				const details = await this.fetchDetailTable(listing.propertyId)
				const map = details.map

				const baujahr = map.get("Baujahr")
				listing.costs.coldRentEur = this.parseGermanFloatOrNull(
					map.get("Kaltmiete"),
				)
				listing.costs.utilityEur = this.parseGermanFloatOrNull(
					map.get("Nebenkosten"),
				)
				listing.costs.totalRentEur = this.parseGermanFloatOrNull(
					map.get("Warmmiete"),
				)
				listing.costs.depositEur = this.parseGermanFloatOrNull(
					map.get("Kaution"),
				)
				listing.costs.heatingEur = this.parseGermanFloatOrNull(
					map.get("Heizkosten"),
				)

				listing.newBuilding =
					baujahr === undefined ? null : Number(baujahr) >= 2014

				listing.features = details.features
			} catch (err) {
				log.warn(
					" -> Failed to backfill data from HOWOGE - " +
						`propertyId: ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	private toListing(params: ToListingParams): ApartmentListing {
		const { totalRentEur, restrictions, images, spaceQm, rooms, ...rest } =
			params
		return {
			...rest,
			lastSeenAt: Date.now(),
			organization: this.organization,
			costs: { totalRentEur },
			spaceQm: Number(spaceQm),
			rooms: Number(rooms),
			restrictions: restrictions ?? restrictionFromTitle(rest.title),
			images: images ?? [],
		}
	}

	private extractListing(
		immo: HowogeResponse["immoobjects"][number],
  ): ApartmentListing {
    // immo.title is the street address, not a description - immo.notice
		// holds the actual listing text
		const parsedAddress = parseAddress(
			immo.title,
			"{street} {houseNumber}, {postalCode} {city}",
		)
		return this.toListing({
			propertyId: immo.link.split("/")[4].slice(0, -5),
			title: immo.notice.trim(),
			fullUrl: `https://howoge.de${immo.link}`,
			spaceQm: immo.area,
			rooms: immo.rooms,
			totalRentEur: immo.rent,
			location: {
				postalCode: required(
					parsedAddress.postalCode,
					`postalCode in "${immo.title}"`,
				),
				city: required(parsedAddress.city, `city in "${immo.title}"`),
				street: required(parsedAddress.street, `street in "${immo.title}"`),
				houseNumber: required(
					parsedAddress.houseNumber,
					`houseNumber in "${immo.title}"`,
				),
				neighborhood: immo.district,
				coordinates: {
					lat: Number(immo.coordinates.lat),
					lng: Number(immo.coordinates.lng),
				},
			},
			accessibility: {
				wheelchair: immo.features.includes("rollstuhlgerecht"),
				barrierFree: immo.features.includes("barrierefrei"),
			},
			restrictions:
				immo.wbs === "ja"
					? {
							kind: "wbs-required",
							wbsLevels: getWbsLevels(immo.notice),
							wbsSpecialNeed: getSpecialNeed(immo.notice),
						}
					: restrictionFromTitle(immo.notice),
			features: immo.features,
			images: [
				{
					fullUrl: `https://howoge.de${immo.image}`,
				},
			],
		})
	}

	private extractTeaserListing(
		flat: HTMLElement,
		teaserUrl: string,
	): ApartmentListing {
		const href = required(
			flat.getAttribute("href"),
			`.flat-single href in ${teaserUrl}`,
		)
		const title = required(
			flat.querySelector(".notice"),
			`.notice in ${teaserUrl}`,
		).text.trim()
		const addressText = required(
			flat.querySelector(".address"),
			`.address in ${teaserUrl}`,
		).text
		const parsedAddress = parseAddress(
			addressText,
			"{street} {houseNumber}, {postalCode} {city}",
		)
		const spaceEl = required(
			flat.querySelector(ATTR_SPACE),
			`space attribute in ${teaserUrl}`,
		)
		const roomsEl = required(
			flat.querySelector(ATTR_ROOMS),
			`rooms attribute in ${teaserUrl}`,
		)
		const rentEl = required(
			flat.querySelector(ATTR_RENT),
			`rent attribute in ${teaserUrl}`,
		)
		const features = flat
			.querySelectorAll(".feature")
			.map((s) => s.textContent.trim())

		return this.toListing({
			propertyId: href.split("/")[4].slice(0, -5),
			title,
			fullUrl: `https://howoge.de${href}`,
			spaceQm: this.parseGermanFloat(spaceEl.text),
			rooms: this.parseGermanFloat(roomsEl.text),
			totalRentEur: this.parseGermanFloat(rentEl.text.trim().split("\n")[0]),
			location: {
				postalCode: required(
					parsedAddress.postalCode,
					`postalCode in ${teaserUrl}`,
				),
				city: required(parsedAddress.city, `city in ${teaserUrl}`),
				street: required(parsedAddress.street, `street in ${teaserUrl}`),
				houseNumber: required(
					parsedAddress.houseNumber,
					`houseNumber in ${teaserUrl}`,
				),
			},
			features,
			newBuilding: true,
			accessibility: {
				wheelchair: features.includes("rollstuhlgerecht"),
				barrierFree: features.includes("barrierefrei"),
			},
		})
	}

	async getListings(): Promise<ApartmentListing[]> {
		const listUrl =
			"https://www.howoge.de/?type=999&" +
			"tx_howrealestate_json_list[action]=immoList"
		const listBody =
			"tx_howrealestate_json_list%5Blang%5D=&" +
			"tx_howrealestate_json_list%5Brooms%5D=&" +
			"tx_howrealestate_json_list%5Bwbs%5D="
		const fetchResult = await this.fetchJson<HowogeResponse>(listUrl, {
			credentials: "include",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			},
			referrer: "https://www.howoge.de/immobiliensuche/wohnungssuche.html",
			body: listBody,
			method: "POST",
			mode: "cors",
		})
		const result = fetchResult.immoobjects.map((immo) =>
			this.extractListing(immo),
		)

		const projectTeaserUrls = fetchResult.projectteaser.map((t) => t.link)

		const teaserResults = await runConcurrent(
			projectTeaserUrls,
			6,
			async (teaserUrl: string) => {
				try {
					const root = await this.fetchHtml(teaserUrl)
					return root
						.querySelectorAll(".flat-single")
						.map((flat) => this.extractTeaserListing(flat, teaserUrl))
				} catch (err) {
					log.warn(`Howoge teaser parsing failed for ${teaserUrl}: ${err}`)
					return []
				}
			},
		)

		return this.dedupeByPropertyId([...result, ...teaserResults.flat()])
	}
}

export default Howoge
