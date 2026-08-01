import { readFileSync } from "node:fs"
import { join } from "node:path"
import { bgGreen, bgGreenBright, bgRed, black, bold, underline, white } from "colorette"
import { getBorderCharacters, type TableUserConfig, table } from "table"
import { printBanner as renderBanner } from "../core/banner"
import log from "../logger/logger"

const ROW_COLUMN_WIDTHS = [18, 10, 9, 9]

const ROW_CONFIG: TableUserConfig = {
	columnDefault: {
		width: 20,
		paddingLeft: 0,
		paddingRight: 0,
	},
	columns: ROW_COLUMN_WIDTHS.map((width) => ({ width })),
	border: getBorderCharacters(`void`),
	drawHorizontalLine: () => false,
}

const SUMMARY_CONFIG: TableUserConfig = {
	columnDefault: {
		width: ROW_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0),
		alignment: "center",
		paddingLeft: 0,
		paddingRight: 0,
	},
	border: getBorderCharacters(`void`),
}

function renderRow(
	cells: string[],
	config: TableUserConfig = ROW_CONFIG,
): string {
	return table([cells], config).replaceAll("\n", "")
}

export function logTableHeader() {
	log.info(
		underline(
			bold(bgGreenBright(renderRow([" From", "Count", "Time", "Requests"]))),
		),
	)
}

export function logScraperResult(
	organization: string,
	count: number,
	durationMs: number,
	requestsCount: number,
) {
	log.info(
		black(
			bgGreen(
				renderRow([
					` ${organization}`,
					`${count} flats`,
					`${durationMs}ms `,
					`${requestsCount}`,
				]),
			),
		),
	)
}

export function logScraperError(organization: string, durationMs: number) {
	log.info(
		white(
			bgRed(renderRow([` ${organization}`, `failed`, `${durationMs}ms `, `-`])),
		),
	)
}

export function logSummary(count: number, durationMs: number) {
	log.info(
		black(
			bgGreen(
				renderRow(
					[`> Found ${count} unique flats in ${durationMs}ms! <`],
					SUMMARY_CONFIG,
				),
			),
		),
	)
}

export async function printBanner() {
	const searchMessageList: string[] = JSON.parse(
		readFileSync(
			join(import.meta.dirname, "searchMessages.json"),
			"utf-8",
		),
	)
	const randomMessage =
		searchMessageList[Math.floor(Math.random() * searchMessageList.length)]
	await renderBanner(randomMessage)
}
