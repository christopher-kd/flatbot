// Zips parallel label/value arrays scraped from key-value HTML tables
// (th/td, dt/dd) into a lookup. Map, not a plain object, since labels
// come from external HTML and could collide with Object.prototype keys
// (e.g. "constructor").
export function zipKeyValueText(
	keys: string[],
	values: string[],
): Map<string, string> {
	const result = new Map<string, string>()
	for (let i = 0; i < keys.length; i++) {
		result.set(keys[i], values[i])
	}
	return result
}
