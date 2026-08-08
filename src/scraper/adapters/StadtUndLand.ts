import log from "../../logger/logger"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { restrictionFromTitle } from "../wbs"
import type { DistrictData, StadtUndLandReponse } from "./StadtUndLand.types"

type StadtUndLandApartment = StadtUndLandReponse["data"][number]

class StadtUndLand extends Scraper {

  constructor() {
    super("Stadt und Land")
		this.concurrency = 12
  }

  public async backfill(listings: ApartmentListing[]): Promise<void> {
    await this.runBackfillStep("features", () => this.backfillFeatures(listings))
  }

  private async fetchDetails(url: string): Promise<Map<string, string>> {
    const page = await this.fetchHtml(url)

    const detailKeys = page.querySelectorAll("[class^='Table_desktopTable'] th")
      .map(elem => elem.innerText.trim())
    const detailValues = page.querySelectorAll("[class^='Table_desktopTable'] td")
      .map(elem => elem.innerText.trim())

    return zipStrings(detailKeys, detailValues)
  }

  private async backfillFeatures(listings: ApartmentListing[]) {
    const targetedListings = listings.filter(listing => !listing.features)

    await runConcurrent(targetedListings, this.concurrency, async (listing) => {
      try {
        const details = await this.fetchDetails(listing.fullUrl)
        const features = (details.get("Ausstattung") ?? "").split(", ")
        listing.features = features
      } catch (err) {
        log.warn(
          ` -> Failed to backfill features for id ${listing.propertyId}: ${err}`,
        )
      }
    })
  }


	private fetchApartments(
		offset: number,
		newBuildingOnly?: boolean,
	): Promise<StadtUndLandReponse> {
		return this.fetchJson(
			"https://d2396ha8oiavw0.cloudfront.net/sul-main/immoSearch",
			{
				credentials: "omit",
				headers: {
					"Content-Type": "text/plain;charset=UTF-8",
				},
				referrer: "https://stadtundland.de/",
				body: JSON.stringify({
					cat: "wohnung",
					new: newBuildingOnly || false,
					offset,
				}),
				method: "POST",
				mode: "cors",
			},
		)
	}


 /**
 * Has parameter newBuildingOnly, so that we can fetch all, and only ones that
 * are new buildings, so that we can tell if on our end, which apartments are
 * new buildings and which aren't.
 * @param newBuildingOnly To fetch only apartments that are new buildings
 * @returns Promise<StadtUndLandApartment[]>
 */
	private async fetchAllApartments(
		newBuildingOnly?: boolean,
	): Promise<StadtUndLandApartment[]> {
		const initial = await this.fetchApartments(0, newBuildingOnly)
		const items = initial.data
		let offset = 0
		while (items.length < initial.count) {
			offset += 10
			items.push(...(await this.fetchApartments(offset, newBuildingOnly)).data)
		}
		return items
	}

	private extractListing(
		apartment: StadtUndLandApartment,
    newBuildingIds: Set<string>,
		subdistrictToDistrict: Map<string, string>
	): ApartmentListing {
    const title = apartment.headline
		const coldRentEur = this.parseGermanFloat(apartment.costs.coldRent)
		return {
			propertyId: apartment.details.immoNumber,
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl:
				`https://stadtundland.de/wohnungssuche/${apartment.details.immoNumber}`,
			location: {
				postalCode: apartment.address.postal_code,
				city: "Berlin",
				street: apartment.address.street,
				houseNumber: apartment.address.house_number,
				neighborhood: subdistrictToDistrict.get(apartment.address.precinct),
			},
			spaceQm: Number(apartment.details.livingSpace),
			rooms: Number(apartment.details.rooms),
			newBuilding: newBuildingIds.has(apartment.details.immoNumber),
			accessibility: {
				wheelchair: apartment.details.wheelchairFriendly,
				senior: apartment.details.seniorsFriendly,
				barrierFree: apartment.details.barrierFree,
			},
			costs: {
        coldRentEur,
        depositEur: Math.ceil(coldRentEur * 3 * 100) / 100,
				utilityEur: this.parseGermanFloat(apartment.costs.additionalCosts),
				heatingEur: this.parseGermanFloat(apartment.costs.heatingCosts),
				totalRentEur: this.parseGermanFloat(apartment.costs.totalRent),
			},
			restrictions: restrictionFromTitle(title),
			images: [
				{
					fullUrl:
						"https://stadtundland.de/_next/image?url=" +
						"https%3A%2F%2Fd2396ha8oiavw0.cloudfront.net/" +
						`${apartment.image.filename}&w=1080&q=75`,
					alt: apartment.image.alt,
					format: apartment.image.format,
				},
			],
		} as ApartmentListing
  }

  async fetchDistrics(): Promise<DistrictData> {
    return await this.fetchJson("https://d2396ha8oiavw0.cloudfront.net/sul-main/districts")
  }

	async getListings(): Promise<ApartmentListing[]> {
		const [apartments, newApartments, districts] = await Promise.all([
			this.fetchAllApartments(),
      this.fetchAllApartments(true),
			this.fetchDistrics()
		])
		const newBuildingIds = new Set(
			newApartments.map((a) => a.details.immoNumber),
		)
		const subdistrictToDistrict = new Map(
			districts.flatMap(({ district, subdistrict }) =>
				subdistrict.map((sub) => [sub, district] as const),
			),
		)

		const result = apartments.map((apartment) =>
			this.extractListing(apartment, newBuildingIds, subdistrictToDistrict),
		)
		return result
	}
}

export default StadtUndLand
