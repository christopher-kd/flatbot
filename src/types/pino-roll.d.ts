declare module "pino-roll" {
	import type { SonicBoom, SonicBoomOpts } from "sonic-boom"

	interface PinoRollOptions extends Omit<SonicBoomOpts, "dest"> {
		file?: string | (() => string)
		size?: number | string
		frequency?: number | string
		interval?: number | string
		limit?: { count?: number; removeOtherLogFiles?: boolean }
		mkdir?: boolean
	}

	export default function build(options: PinoRollOptions): Promise<SonicBoom>
}
