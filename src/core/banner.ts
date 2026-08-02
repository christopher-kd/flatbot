import { blue, cyanBright, italic } from "colorette"
import figlet from "figlet"

export async function printBanner(message: string): Promise<void> {
	const banner = await figlet.text("FLATBOT", {
		font: "Tmplr",
	})
	const output = [
		`\n${blue(banner).trim().split("\n").slice(0, -1).join("\n")}`,
		`${italic(cyanBright(message))}\n`,
	]
	console.log(output.join("\n"))
}
