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
				!costs.coldRentEur ||
				!costs.depositEur ||
				!costs.heatingEur ||
				!costs.utilityEur ||
				!listing.newBuilding
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

		const costsTable = required(
			page.querySelector(".immoDetailTable"),
			`querySel costs table${listing.fullUrl}`,
		)
		const th = costsTable.querySelectorAll("th")
		const td = costsTable
			.querySelectorAll("td")
			.flatMap((td) => this.parseGermanFloat(td.textContent))
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
			{} as Record<string, number>,
		)

		listing.costs = {
			...listing.costs,
			coldRentEur: costsMap["Kaltmiete"],
			depositEur: costsMap["Kaution"],
			heatingEur: costsMap["Heizkosten"],
			utilityEur: costsMap["Betriebskosten"],
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

		listing.newBuilding = Number(factsMap["Baujahr"]) >= 2014
	}

	private async extractListing(
		elem: GesobauResponse[number],
	): Promise<ApartmentListing> {
		const street = elem.raw.adresse_stringS.split(" ")
		const houseNumber = street.pop() ?? ""
		const imagesObj: ApartmentListingImage[] = (() => {
			if (elem.image) {
				return [
					{
						fullUrl: elem.image.figure.media.image.src,
					},
				]
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
				wheelchair: elem.raw.rollstuhlgerecht_boolS ?? false,
				senior: elem.raw.fuerSenioren_boolS ?? false,
				barrierFree: elem.raw.barrierefrei_boolS ?? false,
			},
			restrictions: {
				kind: !elem.raw.noWbs_boolS
					? "wbs-required"
					: classifyRestriction(elem.raw.title).restriction,
				wbsLevels: getWbsLevels(elem.raw.title),
				wbsSpecialNeed: getSpecialNeed(elem.raw.title),
			},
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
			// "Service"/"Senioren Kachel"/"Bestand"/"Studierende"/
			// "Neubau Kachel" channels
			"befilter[1]":
				'kanal_stringM:("Service" OR "Senioren Kachel" OR ' +
				'"Bestand" OR "Studierende" OR "Neubau Kachel")',
		}).toString()
		const json = await this.fetchJson<GesobauResponse>(searchUrl)

		const result: ApartmentListing[] = []
		for (const elem of json) {
			result.push(await this.extractListing(elem))
		}
		return this.dedupeByPropertyId(result)
	}
}
