import { blue, cyanBright, italic } from "colorette"
import figlet from "figlet"

export async function printBanner(): Promise<void> {
	const banner = await figlet.text("FLATBOT", {
		font: "Tmplr",
	})
	const output = [
		`\n${blue(banner).trim().split("\n").slice(0, -1).join("\n")}\n`
	]
  console.log(output.join("\n"))
}
