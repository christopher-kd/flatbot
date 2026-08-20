import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import type ListingRepository from "../../db/repository/ListingRepository"
import log from "../../logger/logger"
import { toRepositoryFilters, toRepositorySort } from "../listings/query"
import { listingsQuerySchema } from "../listings/schema"
import { toListingSummary } from "../types"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export function createListingsRoute(listingRepository: ListingRepository) {
	const listings = new Hono()

	listings.get("/", zValidator("query", listingsQuerySchema), async (c) => {
		const query = c.req.valid("query")
		const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
		const offset = query.offset ?? 0

		try {
			const { items, total } = await listingRepository.queryListings(
				toRepositoryFilters(query),
				toRepositorySort(query.sort),
				limit,
				offset,
			)
			return c.json({
				total,
				limit,
				offset,
				items: items.map(({ listing, distanceKm }) =>
					toListingSummary(listing, distanceKm),
				),
			})
		} catch (err) {
			log.error(err, "Failed to query listings")
			return c.json({ error: "Internal server error" }, 500)
		}
	})

	listings.get("/:listingId", async (c) => {
		try {
			const listing = await listingRepository.findByListingId(
				c.req.param("listingId"),
			)
			if (!listing) return c.json({ error: "Listing not found" }, 404)
			return c.json(listing)
		} catch (err) {
			log.error(err, "Failed to fetch listing")
			return c.json({ error: "Internal server error" }, 500)
		}
	})

	return listings
}
