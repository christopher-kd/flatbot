import parse, { type HTMLElement } from "node-html-parser"
import log from "../../logger/logger"
import type { ApartmentListing } from "../../types"
import Scraper from "../Scraper"
import { parseAddress } from "../util/address"
import { runConcurrent } from "../util/concurrency"
import { zipStrings } from "../util/zip"
import { restrictionFromTitle } from "../wbs"
import { required } from "../util/assert"

const BASE_URL = "https://www.degewo.de"

export default class Degewo extends Scraper {
	constructor() {
		super("degewo")
  }

  public async backfill(listings: ApartmentListing[]): Promise<void> {
    await this.runBackfillStep("costs", () =>
      this.backfillData(listings)
    )
  }

  private async fetchDetailPageData(url: string): Promise<{
    detailData: Map<string, string>, features: string[]
  }> {
    const html = await this.fetchHtml(url)

    const header = required(
      html.querySelector(".c-info-box"),
      "header with blue bg and two circles"
    )
    const headerDetailData = zipStrings(
      header.querySelectorAll("dt").map(item => item.innerText.trim()),
      header.querySelectorAll("dd").map(item => item.innerText.trim()),
    )

    const tables = required(
      html.querySelector("#section-def-list-rent-details"),
      "tables: kosten, objektdetails, energiedaten"
    )
    const tableDetailData = zipStrings(
      tables.querySelectorAll("dt").map(item => item.innerText.trim()),
      tables.querySelectorAll("dd").map(item => item.innerText.trim()),
    )

    const features = html.querySelectorAll(".c-tag__label").map(elem => elem.innerText.trim())

    return {
      detailData: new Map([...headerDetailData, ...tableDetailData]),
      features
    }
  }

  private async backfillData(listings: ApartmentListing[]): Promise<void> {
    const listingTargets = listings.filter(listing =>
      listing.costs.depositEur === 0 ||
      listing.costs.coldRentEur === 0 ||
      listing.costs.utilityEur === 0 ||
      listing.costs.heatingEur === 0 ||
      !listing.newBuilding ||
      !listing.features ||
      !listing.accessibility?.barrierFree
    )

    await runConcurrent(listingTargets, this.concurrency, async listing => {
      try {
        const data = await this.fetchDetailPageData(listing.fullUrl)
        const details = data.detailData
        const coldRentEur = this.parseGermanFloat(details.get("Nettokaltmiete") ?? "")
        const utilityColdEur = this.parseGermanFloat(details.get("Betriebskosten (kalt)") ?? "")
        const utilityWarmEur = this.parseGermanFloat(details.get("Betriebskosten (warm)") ?? "")
        const yearBuilt = Number(details.get("Baujahr") ?? "")

        listing.costs.coldRentEur = coldRentEur
        listing.costs.utilityEur = utilityColdEur + utilityWarmEur
        listing.costs.heatingEur = utilityWarmEur
        listing.costs.depositEur = coldRentEur * 3
        listing.newBuilding = yearBuilt >= 2014
        listing.features = data.features
        listing.accessibility ??= {}
        listing.accessibility.barrierFree = data.features.findIndex(item => item === "Barrierefrei") >= 0
      } catch (err) {
        log.warn(` -> Failed to backfill data for id ${listing.propertyId}: ${err}`)
      }
    })
  }

	private async fetchPage(page: number, cHash?: string) {
		const url = new URL("https://www.degewo.de/immosuche")
		if (page !== 1) {
			const searchParams = new URLSearchParams({
				"tx_openimmo_immobilie[page]": page.toString(),
				"tx_openimmo_immobilie[search]": "paginate",
			})
			if (cHash) {
				searchParams.set("cHash", cHash)
			}
			url.search = searchParams.toString()
		}
		return this.fetchText(url.toString(), {
			credentials: "omit",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Sec-GPC": "1",
				"Upgrade-Insecure-Requests": "1",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-User": "?1",
				Priority: "u=0, i",
			},
			method: "GET",
			mode: "cors",
		})
	}

	// TYPO3 only exposes a page's cHash on an already-fetched page, so the
	// full page set is discovered wave by wave: fetch known pages, collect
	// newly-linked page numbers, repeat until nothing new turns up.
	private extractPaginationLinks(
		root: HTMLElement,
	): Map<number, string | undefined> {
		const found = new Map<number, string | undefined>()
		for (const link of root.querySelectorAll(".c-pagination__list a[href]")) {
			const href = link.getAttribute("href")
			if (!href) continue
			const url = new URL(href, BASE_URL)
			const pageNum = parseInt(
				url.searchParams.get("tx_openimmo_immobilie[page]") ?? "",
				10,
			)
			if (Number.isNaN(pageNum)) continue
			found.set(pageNum, url.searchParams.get("cHash") ?? undefined)
		}
		return found
	}

	private extractListing(teaser: HTMLElement): ApartmentListing | null {
    const title = teaser.querySelector("h3").innerText.trim()
		const imageSrc = teaser.querySelector("figure img")?.getAttribute("src")
		const rawAddress = teaser
			.querySelector("p")
			.innerText.trim()
			.replace(/ Aufgang \d+/, "")
		let street: string, houseNumber: string, precinct: string
		try {
			;({ street, houseNumber, precinct } = parseAddress(
				rawAddress,
				"{street} {houseNumber} &#124; {precinct}",
			))
		} catch (err) {
			log.warn(
				`degewo: couldn't parse address "${rawAddress}", skipping: ${err}`,
			)
			return null
		}
		return {
			propertyId: teaser
				.querySelector("[data-openimmo-bookmark-item-uid]")
				?.getAttribute("data-openimmo-bookmark-item-uid"),
			organization: this.organization,
			lastSeenAt: Date.now(),
			title,
			fullUrl: `${BASE_URL}${teaser.querySelector("h3 a").getAttribute("href")}`,
			location: {
				street,
				houseNumber,
				neighborhood: precinct,
				city: "Berlin",
			},
			spaceQm: parseInt(
				teaser.querySelector("dl>div:nth-child(3)>dt").textContent,
				10,
			),
			rooms: parseInt(
				teaser.querySelector("dl>div:nth-child(2)>dt").textContent,
				10,
			),
			restrictions: restrictionFromTitle(title),
			costs: {
				totalRentEur: this.parseGermanFloat(
					teaser.querySelector("dl>div:nth-child(1)>dt").textContent,
				),
			},
			images: imageSrc
				? [
						{
							fullUrl: `${BASE_URL}${imageSrc}`,
						},
					]
				: [],
		} as ApartmentListing
	}

	private extractListings(root: HTMLElement): ApartmentListing[] {
		return root
			.querySelectorAll(".c-teaser--apartment")
			.flatMap((teaser) => this.extractListing(teaser) ?? [])
	}

	protected async getListings(): Promise<ApartmentListing[]> {
		const known = new Map<number, string | undefined>([[1, undefined]])
		const visited = new Map<number, HTMLElement>()
		let frontier = [1]

		while (frontier.length > 0) {
			const roots = await runConcurrent(
				frontier,
				this.concurrency,
				async (pageNum) => {
					return parse(await this.fetchPage(pageNum, known.get(pageNum)))
				},
			)

			const newFrontier: number[] = []
			frontier.forEach((pageNum, i) => {
				const root = roots[i]
				visited.set(pageNum, root)
				for (const [linkedPage, cHash] of this.extractPaginationLinks(root)) {
					if (!known.has(linkedPage)) {
						known.set(linkedPage, cHash)
						newFrontier.push(linkedPage)
					}
				}
			})
			frontier = newFrontier
		}

		const allListings = [...visited.values()].flatMap((root) =>
			this.extractListings(root),
		)
		return this.dedupeByPropertyId(allListings)
	}
}
