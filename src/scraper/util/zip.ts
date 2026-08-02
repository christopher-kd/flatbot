export function zipStrings(
	keys: string[],
	values: string[],
): Map<string, string> {
	const result = new Map<string, string>()
	for (let i = 0; i < keys.length; i++) {
		result.set(keys[i], values[i])
	}
	return result
}
