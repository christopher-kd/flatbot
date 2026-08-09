#!/bin/sh
set -eu

INTERVAL_SECONDS="${SCRAPE_INTERVAL_SECONDS:-600}"

while true; do
	echo "[scraper] starting run at $(date -Iseconds)"
	bun src/scraper/run.ts || echo "[scraper] run exited non-zero, continuing to next interval"
	echo "[scraper] sleeping ${INTERVAL_SECONDS}s"
	sleep "$INTERVAL_SECONDS"
done
