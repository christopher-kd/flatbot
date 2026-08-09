import { Listr } from "listr2"
import type ListingRepository from "../db/repository/ListingRepository"
import log from "../logger/logger"
import type {
	ApartmentListing,
	ApartmentListingLocation,
	Organization,
} from "../types"
import {
	backfillOneOrg,
	fillMissingCoordinates,
	hydrateKnownBackfillFields,
	pruneDeadAggregatorOnlyListings,
} from "./backfill"
import { mergeDirectAndAggregatorListings } from "./merge"
import type PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import type { ScraperRunResult } from "./ScraperRunner.types"

// Thrown to fail a task/subtask without dumping a technical error inline
const CHECK_LOGS = "check logs or run with LOG_STYLE=\"normal\""

const RENDERER_OPTIONS = { collapseSubtasks: false, collapseErrors: false }

export async function runFetchAndMergeWithLiveBoard(params: {
	directScrapers: Scraper[]
	aggregatorScraper: Scraper
	execute: (scraper: Scraper) => Promise<ScraperRunResult>
}): Promise<{ listings: ApartmentListing[]; scrapedOrganizations: Organization[] }> {
	const { directScrapers, aggregatorScraper, execute } = params
	const allScrapers = [...directScrapers, aggregatorScraper]
	const results: ScraperRunResult[] = new Array(allScrapers.length)
	let merged: ApartmentListing[] = []
	let directListingIds: Set<string> = new Set()
	let mergedListings: ApartmentListing[] = []

	const tasks = new Listr(
		[
			{
				title: "Fetching listings",
				task: (_ctx, task) =>
					task.newListr(
						allScrapers.map((scraper, index) => ({
							title: `${scraper.organization} — scraping...`,
							task: async (_ctx2, subtask) => {
								const result = await execute(scraper)
								results[index] = result

								if (result.success) {
									subtask.title = `${scraper.organization} — ${result.listings.length} flats (${result.durationMs}ms, ${result.requestsCount} req)`
								} else {
									subtask.title = `${scraper.organization} (${result.durationMs}ms)`
									throw new Error(CHECK_LOGS)
								}
							},
						})),
						{
							concurrent: true,
							exitOnError: false,
							rendererOptions: RENDERER_OPTIONS,
						},
					),
			},
			{
				title: "Merging aggregator data",
				task: (_ctx, task) =>
					task.newListr(
						[
							{
								title: "Merge",
								task: (_ctx2, subtask) => {
									try {
										const aggregatorResult = results[results.length - 1]
										const directResults = results.slice(0, -1)

										const combined = mergeDirectAndAggregatorListings(
											directResults,
											aggregatorResult.listings,
										)
										merged = combined.merged
										directListingIds = combined.directListingIds

										subtask.title = `Merge — ${merged.length} combined listings`
									} catch (err) {
										log.error(`Merge failed: ${err}`)
										subtask.title = "Merge"
										throw new Error(CHECK_LOGS)
									}
								},
							},
							{
								title: "Liveness",
								task: async (_ctx2, subtask) => {
									try {
										const aggregatorOnlyCount = merged.filter(
											(l) =>
												l.listingId && !directListingIds.has(l.listingId),
										).length

										if (aggregatorOnlyCount === 0) {
											mergedListings = merged
											subtask.title = "Liveness — no aggregator-only listings"
											return
										}

										mergedListings = await pruneDeadAggregatorOnlyListings(
											merged,
											directListingIds,
											(checked, total) => {
												subtask.title = `Liveness — checking ${total} aggregator-only listings — ${checked}/${total}`
											},
										)

										const pruned = merged.length - mergedListings.length
										subtask.title = `Liveness — ${pruned} pruned, ${mergedListings.length} unique listings`
									} catch (err) {
										log.error(`Liveness check failed: ${err}`)
										subtask.title = "Liveness"
										throw new Error(CHECK_LOGS)
									}
								},
							},
						],
						{ concurrent: false, rendererOptions: RENDERER_OPTIONS },
					),
			},
		],
		{ concurrent: false, rendererOptions: RENDERER_OPTIONS },
	)
	await tasks.run()

	const scrapedOrganizations: Organization[] = results
		.slice(0, -1)
		.filter((r) => r.success)
		.map((r) => r.organization)

	return { listings: mergedListings, scrapedOrganizations }
}

export async function runHydrateAndBackfillWithLiveBoard(params: {
	listingRepository: ListingRepository
	directScrapers: Scraper[]
	listings: ApartmentListing[]
}): Promise<void> {
	const { listingRepository, directScrapers, listings } = params

	const tasks = new Listr(
		[
			{
				title: "Hydrating known fields from database",
				task: async (_ctx, task) => {
					try {
						await hydrateKnownBackfillFields(listingRepository, listings)
						task.title = "Hydrating known fields from database — done"
					} catch (err) {
						log.error(`Hydration failed: ${err}`)
						task.title = "Hydrating known fields from database"
						throw new Error(CHECK_LOGS)
					}
				},
			},
			{
				title: "Running per-scraper backfills",
				task: (_ctx, task) =>
					task.newListr(
						directScrapers.map((scraper) => ({
							title: `${scraper.organization} — backfilling...`,
							task: async (_ctx2, subtask) => {
								const success = await backfillOneOrg(scraper, listings)
								const requestsCount = scraper.getRequestCount()

								if (success) {
									subtask.title = `${scraper.organization} — done (${requestsCount} req total)`
								} else {
									subtask.title = scraper.organization
									throw new Error(CHECK_LOGS)
								}
							},
						})),
						{
							concurrent: true,
							exitOnError: false,
							rendererOptions: RENDERER_OPTIONS,
						},
					),
			},
		],
		{ concurrent: false, rendererOptions: RENDERER_OPTIONS },
	)
	await tasks.run()
}

export async function runCoordinateFillWithLiveBoard(params: {
	photonClient: PhotonClient
	batches: Array<{
		label: string
		listings: ApartmentListing[]
		addressFor: (location: ApartmentListingLocation) => string
	}>
}): Promise<void> {
	const { photonClient, batches } = params

	const tasks = new Listr<{ photonHealthy: boolean }>(
		[
			{
				title: "Checking Photon connection",
				task: async (ctx, task) => {
					ctx.photonHealthy = await photonClient.healthcheck()
					task.title = ctx.photonHealthy
						? "Checking Photon connection — ok"
						: "Checking Photon connection — unreachable"
				},
			},
			{
				title: "Backfilling coordinates",
				skip: (ctx) =>
					ctx.photonHealthy
						? false
						: "Photon unreachable — skipping coordinate backfill",
				task: (_ctx, task) =>
					task.newListr(
						batches.map(({ label, listings, addressFor }) => ({
							title: `${label} — filling coordinates...`,
							task: async (_ctx2, subtask) => {
								const total = listings.filter(
									(l) => l.location.coordinates === undefined,
								).length
								if (total === 0) {
									subtask.title = `${label} — no missing coordinates`
									return
								}

								await fillMissingCoordinates(
									photonClient,
									listings,
									addressFor,
									(checked, checkedTotal) => {
										subtask.title = `${label} — ${checked}/${checkedTotal} coordinates fetched`
									},
								)
								subtask.title = `${label} — done`
							},
						})),
						{ concurrent: true, rendererOptions: RENDERER_OPTIONS },
					),
			},
		],
		{ concurrent: false, rendererOptions: RENDERER_OPTIONS },
	)
	await tasks.run()
}

export async function runPersistWithLiveBoard(params: {
	listingRepository: ListingRepository
	listings: ApartmentListing[]
	scrapedOrganizations: Organization[]
}): Promise<void> {
	const { listingRepository, listings, scrapedOrganizations } = params

	const tasks = new Listr(
		[
			{
				title: "Saving results",
				task: async (_ctx, task) => {
					await listingRepository.updateListings(
						listings,
						scrapedOrganizations,
						(checked, total) => {
							task.title = `Checking liveness of ${total} untouched listings — ${checked}/${total}`
						},
					)
					task.title = "Saved"
				},
			},
		],
		{ concurrent: false, rendererOptions: RENDERER_OPTIONS },
	)
	await tasks.run()
}
