import log from "../../logger/logger"
import type { ApartmentListing, ApartmentListingImage } from "../../types"
import Scraper from "../Scraper"
import { required } from "../util/assert"
import { runConcurrent } from "../util/concurrency"
import { classifyRestriction, getSpecialNeed, getWbsLevels } from "../wbs"
import type GesobauResponse from "./Gesobau.types"

export default class Gesobau extends Scraper {
	constructor() {
		super("GESOBAU")
	}

	private readonly objectIdRegex = /\d{2}-\d{5}-\d{5}-\d{4}/

	public async backfill(listings: ApartmentListing[]): Promise<void> {
		await this.runBackfillStep("missingData", () =>
			this.backfillMissingData(listings),
		)
	}

	private async backfillMissingData(
		listings: ApartmentListing[],
	): Promise<void> {
		const targets = listings.filter((listing) => {
			const costs = listing.costs
			return (
				costs.coldRentEur === undefined ||
				costs.depositEur === undefined ||
				costs.heatingEur === undefined ||
				costs.utilityEur === undefined ||
				listing.newBuilding === undefined ||
				!listing.features
			)
		})
		await runConcurrent(targets, this.concurrency, async (listing) => {
			try {
				await this.fetchMissingDataFromDetailPage(listing)
			} catch (err) {
				log.warn(
					` -> Failed to backfill missing data for property ${listing.propertyId}: ${err}`,
				)
			}
		})
	}

	private async fetchMissingDataFromDetailPage(
		listing: ApartmentListing,
	): Promise<void> {
		const page = await this.fetchHtml(listing.fullUrl)
		const features = page
			.querySelectorAll(".immoSidebar__tags li")
			.map((elem) => elem.innerText.trim())

		const costsTable = required(
			page.querySelector(".immoDetailTable"),
			`querySel costs table${listing.fullUrl}`,
		)
		const th = costsTable.querySelectorAll("th")
		const td = costsTable.querySelectorAll("td").map((td) => td.textContent)
		const costsMap = th.reduce(
			(acc, key, index) => {
				const value = td[index]
				// Labels render as "Kaltmiete:" etc - strip the trailing colon so
				// they match the plain lookup keys below.
				const label = key.textContent.trim().replace(/:$/, "")
				if (label && value !== undefined) {
					acc[label] = value
				}
				return acc
			},
			{} as Record<string, string>,
		)

		listing.costs = {
			...listing.costs,
			coldRentEur: this.parseGermanFloatOrNull(costsMap["Kaltmiete"]),
			depositEur: this.parseGermanFloatOrNull(costsMap["Kaution"]),
			heatingEur: this.parseGermanFloatOrNull(costsMap["Heizkosten"]),
			utilityEur: this.parseGermanFloatOrNull(costsMap["Betriebskosten"]),
		}

		const listItems = page
			.querySelectorAll(".immoSidebar__keyfacts li")
			.flatMap((c) => c.textContent)
		const factsMap = listItems.reduce(
			(acc, item) => {
				const parts = item.split(": ")
				if (parts.length === 2) {
					acc[parts[0].trim()] = parts[1].trim()
				}
				return acc
			},
			{} as Record<string, string>,
		)

		listing.newBuilding =
			factsMap["Baujahr"] === undefined
				? null
				: Number(factsMap["Baujahr"]) >= 2014

		listing.features = features
	}

	private async extractListing(
		elem: GesobauResponse[number],
	): Promise<ApartmentListing> {
		const street = elem.raw.adresse_stringS.split(" ")
		const houseNumber = street.pop() ?? ""
		const imagesObj: ApartmentListingImage[] = (() => {
			// .image.src always a lazy-load placeholder SVG (blank, data URI);
			// real photo path is .image.srcNoscript
			const src = elem.image?.figure.media.image.srcNoscript
			if (src) {
				return [{ fullUrl: `https://gesobau.de${src}` }]
			}
			return []
		})()
		let roomCount = elem.raw.zimmer_intS
		if (!roomCount) {
			const page = await this.fetchHtml(`https://gesobau.de${elem.detail}`)
			const roomCountLi = required(
				page.querySelector(".immoHero__metaData li:nth-child(2)"),
				"room count selector",
			)
			roomCount = this.parseGermanFloat(roomCountLi.textContent)
		}
		return {
			propertyId: required(
				elem.detail.match(this.objectIdRegex),
				"get PropertyId",
			)[0],
			organization: this.organization,
			lastSeenAt: Date.now(),
			title: elem.raw.title,
			fullUrl: `https://gesobau.de${elem.detail}`,
			location: {
				street: street.join(" "),
				postalCode: elem.raw.plz_stringS,
				city: elem.raw.ort_stringS,
				neighborhood: elem.raw.region_stringM[0],
				houseNumber,
				coordinates: {
					lat: elem.lat,
					lng: elem.lng,
				},
			},
			spaceQm: required(elem.raw.wohnflaeche_floatS, "space in m²"),
			rooms: roomCount,
			accessibility: {
				wheelchair: elem.raw.rollstuhlgerecht_boolS,
				senior: elem.raw.fuerSenioren_boolS ?? null,
				barrierFree: elem.raw.barrierefrei_boolS ?? null,
			},
			restrictions: (() => {
				const restriction = !elem.raw.noWbs_boolS
					? "wbs-required"
					: classifyRestriction(elem.raw.title).restriction
				const wbsLevels = getWbsLevels(elem.raw.title)
				const wbsSpecialNeed = getSpecialNeed(elem.raw.title)
				return restriction === "free"
					? { kind: "free" as const }
					: restriction === "income-checked"
						? { kind: "income-checked" as const, wbsLevels }
						: { kind: "wbs-required" as const, wbsLevels, wbsSpecialNeed }
			})(),
			costs: {
				totalRentEur: required(elem.raw.warmmiete_floatS, "total rent"),
			},
			images: imagesObj,
		}
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		const searchUrl = new URL("https://www.gesobau.de/mieten/wohnungssuche/")
		searchUrl.search = new URLSearchParams({
			resultsPerPage: "10000",
			resultsPage: "0",
			resultAsJSON: "1",
			// residential listings only
			"befilter[0]": "nutzungsart_stringS:WOHNEN",
			// "Service"/"Senioren Kachel"/"Bestand"/"Studierende"/"Neubau" channels.
			// Site's real tag is "Neubau", not "Neubau Kachel" - the old value
			// never matched, silently dropping most new-build listings (proven
			// live: 8 of 10 currently-live GESOBAU listings tagged only "Neubau").
			"befilter[1]":
				'kanal_stringM:("Service" OR "Senioren Kachel" OR ' +
				'"Bestand" OR "Studierende" OR "Neubau")',
		}).toString()
		const json = await this.fetchJson<GesobauResponse>(searchUrl)

		const result: ApartmentListing[] = []
		for (const elem of json) {
			result.push(await this.extractListing(elem))
		}
		return this.dedupeByPropertyId(result)
	}
}
