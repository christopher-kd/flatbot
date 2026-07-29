// Runs `fn` over `items`, never more than `maxConcurrent` in flight at once.
export async function runConcurrent<T, R>(
	items: T[],
	maxConcurrent: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: Promise<R>[] = []
	const active = new Set<Promise<R>>()

	for (const item of items) {
		const promise = fn(item).finally(() => active.delete(promise))
		active.add(promise)
		results.push(promise)
		// Race ignores rejections - one failing task can't abort dispatch of
		// rest; real outcomes still surface in Promise.all below.
		if (active.size >= maxConcurrent) {
			await Promise.race([...active].map((p) => p.catch(() => undefined)))
		}
	}

	return Promise.all(results)
}
