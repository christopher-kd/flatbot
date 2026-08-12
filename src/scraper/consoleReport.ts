import { printBanner as renderBanner } from "../core/banner"
import log from "../logger/logger"
import type Scraper from "./Scraper"
import type { ScraperRunResult } from "./ScraperRunner.types"

export function logScraperResult(
	organization: string,
	count: number,
	durationMs: number,
	requestsCount: number,
) {
	log.info(`${organization}: ${count} flats (${durationMs}ms, ${requestsCount} requests)`)
}

export function logScraperError(organization: string, durationMs: number) {
	log.error(`${organization}: scrape failed (${durationMs}ms)`)
}

export function logSummary(count: number, durationMs: number) {
	log.info(`Found ${count} unique flats in ${durationMs}ms`)
}

/** LOG_STYLE=normal path: plain line-by-line result logs as each scraper settles. */
export async function runScrapersPlain(
	scrapers: Scraper[],
	execute: (scraper: Scraper) => Promise<ScraperRunResult>,
): Promise<ScraperRunResult[]> {
	return Promise.all(
		scrapers.map(async (scraper) => {
			const result = await execute(scraper)
			if (result.success)
				logScraperResult(
					result.organization,
					result.listings.length,
					result.durationMs,
					result.requestsCount,
				)
			else logScraperError(result.organization, result.durationMs)
			return result
		}),
	)
}

export async function printBanner() {
	await renderBanner()
}
