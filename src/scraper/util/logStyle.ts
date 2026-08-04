import { env } from "bun"

export type LogStyle = "dynamic" | "normal"

/** LOG_STYLE=normal for plain line-by-line console logs; anything else (default) is the live scrape board. */
export function getLogStyle(): LogStyle {
	return env.LOG_STYLE === "normal" ? "normal" : "dynamic"
}
