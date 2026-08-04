import type { ApartmentListing, Organization } from "../types"

export interface ScraperRunResult {
	organization: Organization
	listings: ApartmentListing[]
	success: boolean
	durationMs: number
	requestsCount: number
}
