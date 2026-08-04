import type { Organization } from "../../types"

export function groupByOrganization<T extends { organization: Organization }>(
	items: T[],
): Map<Organization, T[]> {
	const groups = new Map<Organization, T[]>()

	for (const item of items) {
		const group = groups.get(item.organization)
		if (group) {
			group.push(item)
		} else {
			groups.set(item.organization, [item])
		}
	}

	return groups
}
