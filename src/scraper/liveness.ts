import parse from "node-html-parser"
import type { ApartmentListing } from "../types"
import log from "../logger/logger"

type LivenessCheckTarget = Pick<
	ApartmentListing,
	"organization" | "fullUrl" | "propertyId"
>

export type LivenessCheckResult = "active" | "inactive" | "not-implemented"

// Shared by orgs where HTTP status is whole signal
async function checkStatusOnly(url: string): Promise<LivenessCheckResult> {
	const response = await fetch(url)
	return response.ok ? "active" : "inactive"
}

/**
 * Confirms a listing is still live by fetching its own `fullUrl`.
 * Plain HTTP status isn't always enough: some landlords pull listing
 * from search while its detail page stays reachable (200).
 */
export async function checkListingLiveness(
	listing: LivenessCheckTarget,
): Promise<LivenessCheckResult> {
	switch (listing.organization) {
		case "Stadt und Land":
			// TODO: implement liveness check for Stadt und Land
			return "not-implemented"
		case "degewo": {
      const response = await fetch(listing.fullUrl)

      if (!response.ok) return "inactive"
      if (response.url.endsWith("/404")) return "inactive"

			const parsedHTML = parse(await response.text())
			const listingDeactivatedText = parsedHTML.querySelector(
				".c-copy .c-headline.c-headline--h2",
			)
			if (listingDeactivatedText) return "inactive"
			return "active"
		}
		case "Gewobag":
			// TODO: implement liveness check for Gewobag
			return "not-implemented"
		case "WBM":
			// TODO: implement liveness check for WBM
			return "not-implemented"
    case "HOWOGE": {
      const response = await fetch(listing.fullUrl)
      if (!response.ok) return "inactive"
      if (response.url.endsWith("/404")) return "inactive"
      return "active"
    }
    case "Vonovia":
    case "GESOBAU":
    case "Deutsche Wohnen":
      return checkStatusOnly(listing.fullUrl)
    case "Berlinovo": {
      const url = new URL(listing.fullUrl)
      return checkStatusOnly(`https://www.berlinovo.de${url.pathname}`)
    }
		case "inberlinwohnen":
			// TODO: implement liveness check for inberlinwohnen
			return "not-implemented"
		default:
			throw new Error(
				`No liveness check implemented for organization: ${listing.organization}`,
			)
	}
}
