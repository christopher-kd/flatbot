import { createWriteStream, existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import cliProgress, { SingleBar } from "cli-progress"
import { cyan } from "colorette"
import { exit } from "node:process"
import { printBanner } from "../core/banner"

type DownloadProgress = {
	downloadedBytes: number
	totalBytes: number | null
	bytesPerSecond: number
}

function formatSpeed(bytesPerSecond: number): string {
	const units = ["B/s", "KB/s", "MB/s", "GB/s"]
	let value = bytesPerSecond
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex++
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`
}

type DownloadableType = {
  id: "jar" | "dump",
  name: string,
  url: string,
  dest: string
}

const PHOTON_DATA_DIR = "./bin/photon"

const downloadables: DownloadableType[] = [
  {
    id: "jar",
    name: "Photon",
    url: "https://github.com/komoot/photon/releases/download/1.2.1/photon-1.2.1.jar",
    dest: `${PHOTON_DATA_DIR}/`
  },
  {
    id: "dump",
    name: "German OSM data dump",
    url: "https://download1.graphhopper.com/public/europe/germany/photon-dump-germany-1.0-latest.jsonl.zst",
    dest: `${PHOTON_DATA_DIR}/temp/`
  },
]

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
}

async function downloadFile(url: string, destPath: string, onProgress?: (progress: DownloadProgress) => void): Promise<void> {
	if (existsSync(destPath)) {
		onProgress?.({ downloadedBytes: 1, totalBytes: 1, bytesPerSecond: 0 })
		return
	}

	const response = await fetch(url)
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`)
	}

	await ensureDir(dirname(destPath))

	const totalBytes = Number(response.headers.get("content-length")) || null
	let downloadedBytes = 0
	const startTime = Date.now()

	const fileStream = createWriteStream(destPath)
	const reader = response.body.getReader()

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			downloadedBytes += value.byteLength
			fileStream.write(value)

			const elapsedSeconds = (Date.now() - startTime) / 1000
			const bytesPerSecond = elapsedSeconds > 0 ? downloadedBytes / elapsedSeconds : 0
			onProgress?.({ downloadedBytes, totalBytes, bytesPerSecond })
		}
	} finally {
		fileStream.end()
	}
}

const REGION_ISO_CODES = ["DE-BE", "DE-BB"] // Berlin, Brandenburg

async function runBunInstall(): Promise<void> {
  const proc = Bun.spawn(["bun", "i"], {
    stdout: "inherit",
    stderr: "inherit",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`bun i failed with exit code ${exitCode}`)
  }
}

async function runPhotonImport(jarPath: string, dumpPath: string, dataDir: string): Promise<void> {
  const isoFilter = REGION_ISO_CODES.join("|")
  const regionFilter = `awk '/"type":"Place"/{if($0~/"(${isoFilter})"/)print;next}{print}'`
  const command = `zstd --stdout -d ${Bun.$.escape(dumpPath)} | ${regionFilter} | java -jar ${Bun.$.escape(jarPath)} import -import-file - -languages de -data-dir ${Bun.$.escape(dataDir)}`
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "inherit",
    stderr: "inherit",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Photon import failed with exit code ${exitCode}`)
  }
}

function createDownloadBars(count: number): SingleBar[] {
  const multibar = new cliProgress.MultiBar({
    format: `{filename} |` + cyan('{bar}') + '| {percentage}% || Speed: {speed}',
    clearOnComplete: false,
    hideCursor: true
  }, cliProgress.Presets.shades_grey)

  const bars = []
  for (let i = 1; i <= count; i++) {
    bars.push(multibar.create(1, 0))
  }
  return bars
}

async function main() {
  await printBanner("Setup project")

  const bars = createDownloadBars(downloadables.length)
  const downloads: Promise<void>[] = []
  const destPaths: Record<DownloadableType["id"], string> = { jar: "", dump: "" }

  for (const [i, downloadableType] of downloadables.entries()) {
    const destPath = join(downloadableType.dest, basename(downloadableType.url))
    destPaths[downloadableType.id] = destPath
    downloads.push(downloadFile(downloadableType.url, destPath, progress => {
      bars[i].update(progress.downloadedBytes / progress.totalBytes, { filename: downloadableType.name, speed: formatSpeed(progress.bytesPerSecond) })
    }))
  }

  await Promise.all(downloads)
  await runPhotonImport(destPaths.jar, destPaths.dump, PHOTON_DATA_DIR)
  await rm(dirname(destPaths.dump), { recursive: true, force: true })
  await runBunInstall()
}


main().then(() => exit(0))
