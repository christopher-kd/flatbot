type DeepPartial<T> = T extends object
	? { [K in keyof T]?: DeepPartial<T[K]> }
	: T

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fillMissingUnsafe(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const key of Object.keys(source)) {
		const sourceValue = source[key]
		if (sourceValue === undefined) continue

		const targetValue = target[key]
		if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
			fillMissingUnsafe(targetValue, sourceValue)
			continue
		}
		if (targetValue !== undefined && targetValue !== null) continue
		target[key] = sourceValue
	}
}

// Recursively fills target's null/undefined fields from source, without
// overwriting existing ones. Source only needs the nested paths it fills.
export function fillMissing<T extends object>(
	target: T,
	source: DeepPartial<T>,
): void {
	fillMissingUnsafe(
		target as Record<string, unknown>,
		source as Record<string, unknown>,
	)
}
