import pino from "pino"

const log = pino({
	level: "debug",
	transport: {
		targets: [
			{
				target: "pino-pretty",
				level: "debug",
				options: {
					colorize: true,
					translateTime: "HH:mm:ss.l",
				},
			},
			{
				target: "pino-roll",
				options: {
					file: "./logs/app.log",
					size: "10m",
					interval: "1d",
					mkdir: true,
				},
			},
		],
	},
})

export default log
