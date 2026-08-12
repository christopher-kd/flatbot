#!/bin/sh
set -eu

DATA_DIR="/photon/photon_data"
DUMP_URL="https://download1.graphhopper.com/public/europe/germany/photon-dump-germany-1.0-latest.jsonl.zst"
DUMP_PATH="/photon/dump.jsonl.zst"

mkdir -p "$DATA_DIR"

if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
	echo "[photon] no existing index in $DATA_DIR, importing Berlin/Brandenburg data"
	curl -fL -o "$DUMP_PATH" "$DUMP_URL"
	zstd --stdout -d "$DUMP_PATH" \
		| awk '/"type":"Place"/{if($0~/"(DE-BE|DE-BB)"/)print;next}{print}' \
		| java -jar photon.jar import -import-file - -languages de -data-dir "$DATA_DIR"
	rm -f "$DUMP_PATH"
else
	echo "[photon] existing index found in $DATA_DIR, skipping import"
fi

exec java -jar photon.jar serve -data-dir "$DATA_DIR" -listen-ip 0.0.0.0
