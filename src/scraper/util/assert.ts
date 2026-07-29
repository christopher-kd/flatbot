function required<T>(value: T | null | undefined, context: string): T {
	if (value === null || value === undefined) {
		throw new Error(`Expected value for ${context}, got ${value}`)
	}
	return value
}

function assertDefined<T>(
	value: T,
	context: string,
): asserts value is NonNullable<T> {
	if (value === null || value === undefined) {
		throw new Error(`Expected value for ${context}, got ${value}`)
	}
}

export { required, assertDefined }
