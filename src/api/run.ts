import { Hono } from "hono"
import { printBanner } from "../core/banner"
import createListingRepository from "../db/createListingRepository"
import { createListingsRoute } from "./routes/listings"

await printBanner()

const { listingRepository } = await createListingRepository()

const app = new Hono()

app.get("/health", (c) => c.json({ status: "ok" }))
app.route("/listings", createListingsRoute(listingRepository))

export default {
	fetch: app.fetch,
	port: process.env.PORT ?? 1470,
}
