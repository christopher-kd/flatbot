export function zipStrings(
	keys: string[],
	values: string[],
): Map<string, string> {
	if (keys.length !== values.length) {
		throw new Error(
			`zipStrings: key/value length mismatch (${keys.length} keys, ` +
				`${values.length} values)`,
		)
	}
	const result = new Map<string, string>()
	for (let i = 0; i < keys.length; i++) {
		result.set(keys[i], values[i])
	}
	return result
}
