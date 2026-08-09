import { runConcurrent } from "./util/concurrency"

const PROXY_LIST_URL =
	"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt"
const CHECK_URL = "https://api.iplocate.io/ip"
const CHECK_TIMEOUT_MS = 5000
const CHECK_CONCURRENCY = 20
const SAMPLE_SIZE = 40

export default class ProxyClient {
	async getWorkingProxies(limit: number): Promise<string[]> {
		const candidates = (await this.fetchCandidates()).slice(0, SAMPLE_SIZE)

		const working: string[] = []
		await runConcurrent(candidates, CHECK_CONCURRENCY, async (proxy) => {
			if (await this.checkProxy(proxy)) working.push(proxy)
		})

		return working.slice(0, limit)
	}

	private async fetchCandidates(): Promise<string[]> {
		const res = await fetch(PROXY_LIST_URL)
		if (!res.ok) {
			throw new Error(`Failed to fetch proxy list: ${res.status}`)
		}
		return (await res.text())
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((hostPort) => `http://${hostPort}`)
	}

	private async checkProxy(proxy: string): Promise<boolean> {
		try {
			const res = await fetch(CHECK_URL, {
				proxy,
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			})
			return res.ok
		} catch {
			return false
		}
	}
}
