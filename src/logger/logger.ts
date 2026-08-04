import { Writable } from "node:stream"
import pino from "pino"
import pretty from "pino-pretty"
import buildRollingFile from "pino-roll"
import { getLogStyle } from "../scraper/util/logStyle"

const silentConsole = new Writable({
	write(_chunk, _encoding, callback) {
		callback()
	},
})

const consoleStream =
	getLogStyle() === "dynamic"
		? silentConsole
		: pretty({ colorize: true, translateTime: "HH:mm:ss.l" })

const fileStream = await buildRollingFile({
	file: "./logs/app.log",
	size: "10m",
	interval: "1d",
	mkdir: true,
})

const log = pino(
	{ level: "debug" },
	pino.multistream([
		{ stream: consoleStream, level: "debug" },
		{ stream: fileStream, level: "debug" },
	]),
)

export default log
