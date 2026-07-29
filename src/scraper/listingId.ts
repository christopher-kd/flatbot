import type { Organization } from "../types"

// Globally unique across orgs, unlike propertyId alone — two unrelated
// landlords' raw IDs could coincide by chance.
export function buildListingId(
	organization: Organization,
	propertyId: string,
): string {
	return `${organization}:${propertyId}`
}
