import type { HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing, Organization } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { required } from "../util/assert"
import { zipStrings } from "../util/zip"
import { classifyRestriction, restrictionFromTitle } from "../wbs"
import type { FeatureArray } from "./InBerlinWohnen.types"

const WOHNUNGSFINDER_URL = "https://www.inberlinwohnen.de/wohnungsfinder"

// inberlinwohnen.de sometimes serves a map pin where lat and lng are
// identical - not a real coordinate pair, so drop it rather than have
// a bad-but-defined value
export function parseMapPinCoordinates(
	wireClick: string,
): { lat: number; lng: number } | undefined {
	const coordsMatch = required(
		wireClick.match(/{.*}/),
		"coords JSON in raw attribute",
	)
	const coords: { lat: string; lon: string } = JSON.parse(coordsMatch[0])
	const lat = Number(coords.lat)
	const lng = Number(coords.lon)
	return lat === lng ? undefined : { lat, lng }
}

export default class InBerlinWohnenScraper extends Scraper {
	constructor() {
		super("inberlinwohnen")
	}

	private getOrganizationByURL(url: string): Organization | null {
		if (url.includes("gewobag.de")) return "Gewobag"
		if (url.includes("stadtundland.de")) return "Stadt und Land"
		if (url.includes("gesobau.de")) return "GESOBAU"
		if (url.includes("howoge.de")) return "HOWOGE"
		if (url.includes("wbm.de")) return "WBM"
		if (url.includes("degewo.de")) return "degewo"
		if (url.includes("berlinovo.de")) return "Berlinovo"
		return null
	}

	private getPropertyIdByURL(url: string, organization: Organization): string {
		if (organization === "HOWOGE")
			return required(
				url.match(/\d+-\d+-\d+(?=.html\?)/),
				"HOWOGE propertyId match",
			)[0]
		if (organization === "WBM")
			return required(url.match(/\d+-\d+\/\d+\/\d+/), "WBM propertyId match")[0]
		if (organization === "Stadt und Land")
			return decodeURIComponent(
				required(
					url.match(/\d{4}%2F\w+%2F\d+/),
					"Stadt und Land propertyId match",
				)[0],
			)
		if (organization === "Gewobag")
			return required(
				url.match(/\d+-\d+-\d+\d-\d+/),
				"Gewobag propertyId match",
			)[0]
		if (organization === "degewo") {
			const raw = required(
				url.match(/W\d+-\d+-\d+\d-\d+/),
				"degewo propertyId match",
			)[0]
			// degewo now uses dots, not dashes - normalize to match direct scraper's IDs
			return raw.replace(/-/g, ".").replace(/\.(\d+)$/, "-$1")
		}
		if (organization === "GESOBAU")
			return required(
				url.match(/\d{2}-\d{5}-\d{5}-\d{4}/),
				"GESOBAU propertyId match",
			)[0]
		if (organization === "Berlinovo")
			return required(
				url.match(/\d{4}-\d{4}-\d{1,}/),
				"Berlinovo propertyId match",
			)[0]
		return ""
	}

	private parseDtDdTable(apartment: HTMLElement): Map<string, string> {
		const keys = apartment
			.querySelectorAll(".list__details .table dt")
			.map((sel) => sel.textContent.trim().slice(0, -1))
		const values = apartment
			.querySelectorAll(".list__details .table dd")
			.map((sel) => sel.textContent.trim())
		return zipStrings(keys, values)
	}

	public extractListing(apartment: HTMLElement): ApartmentListing {
		const title = required(
			apartment.querySelector(".list__details>span:first-child"),
			"apartment title",
		).textContent

		const table = this.parseDtDdTable(apartment)

		const coordsRaw = required(
			required(
				apartment.querySelector("button.text-right"),
				"map button",
			).getAttribute("wire:click"),
			"attribute of raw coords",
		)
		const coordinates = parseMapPinCoordinates(coordsRaw)

		const url = required(
			apartment.querySelector(".list__details a")?.getAttribute("href"),
			"apartment url",
		)

		const features: FeatureArray = apartment
			.querySelectorAll(".list__details span:has(i)")
			.map((sel) => sel.textContent.trim())

		const organization = (() => this.getOrganizationByURL(url))()
		if (!organization) throw new Error("Couldn't determine organization")
		const addr = parseAddress(
			required(table.get("Adresse"), "Adresse"),
			"{street} {houseNumber}, {postalCode}, {precinct}",
		)

		return {
			organization,
			propertyId: this.getPropertyIdByURL(url, organization),
			lastSeenAt: Date.now(),
			title,
			fullUrl: url,
			location: {
				postalCode: required(addr.postalCode, "postalcode"),
				city: "Berlin",
				street: required(addr.street, "street"),
				houseNumber: required(addr.houseNumber, "houseNumber"),
				neighborhood: addr.precinct,
				coordinates,
			},
			spaceQm: this.parseGermanFloatOrNull(table.get("Wohnfläche")),
			rooms: this.parseGermanFloat(table.get("Zimmeranzahl") ?? ""),
			newBuilding:
				Number(required(table.get("Baujahr"), "Baujahr").trim()) >= 2014,
			costs: {
				coldRentEur: this.parseGermanFloatOrNull(table.get("Kaltmiete")),
				utilityEur: this.parseGermanFloatOrNull(table.get("Nebenkosten")),
				totalRentEur: this.parseGermanFloatOrNull(table.get("Gesamtmiete")),
			},
			accessibility: {
				barrierFree: features.includes("Barrierefrei"),
				senior: features.includes("Seniorenwohnung"),
				wheelchair: features.includes("Weitgehend rollstuhlgerecht"),
			},
			// "unbekannt" is a real third state, seen live. Site has no
			// opinion, so use title only - same as adapters with no WBS field.
			restrictions: ((wbsField: string) => {
				if (wbsField === "unbekannt") return restrictionFromTitle(title)
				const fromTitle = classifyRestriction(title)
				if (wbsField === "erforderlich") {
					return {
						kind: "wbs-required" as const,
						wbsLevels: fromTitle.levels,
						wbsSpecialNeed: fromTitle.specialNeed,
					}
				}
				return fromTitle.restriction === "income-checked"
					? { kind: "income-checked" as const, wbsLevels: fromTitle.levels }
					: { kind: "free" as const }
			})(required(table.get("WBS"), "WBS").trim()),
			features,
			images: [],
		}
	}

	public async getListings(): Promise<ApartmentListing[]> {
		// .pagination .flex button:last-child names the total page count, read
		// off page 1 only — same shape as Gewobag/Berlinovo, see paginateHtmlPages.
		const pages = await this.paginateHtmlPages(
			(pageNumber) =>
				this.fetchHtml(
					pageNumber === 1
						? WOHNUNGSFINDER_URL
						: `${WOHNUNGSFINDER_URL}?page=${pageNumber}`,
				),
			(firstPage) =>
				Number(
					firstPage.querySelector(".pagination .flex button:last-child")
						?.textContent,
				),
			8,
		)

		return pages.flatMap((page) =>
			page.querySelectorAll("[id^=apartment]").flatMap((apartment) => {
				try {
					return [this.extractListing(apartment)]
				} catch (err) {
					log.warn(`inberlinwohnen: failed to extract listing: ${err}`)
					return []
				}
			}),
		)
	}
}
