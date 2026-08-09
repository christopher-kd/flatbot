import { env } from "bun"
import log from "../logger/logger"
import type { GeoJsonResponse } from "../types/photon"
import { required } from "./util/assert"

export default class PhotonClient {
	#port: string
	// Defaults to localhost for local dev
	#host: string

	constructor() {
		this.#port = required(env.PHOTON_API_PORT, "PHOTON_API_PORT")
		this.#host = env.PHOTON_API_HOST ?? "localhost"
	}

	async healthcheck(): Promise<boolean> {
		try {
			const response = await fetch(
				`http://${this.#host}:${this.#port}/status`,
			)
			return response.ok
		} catch (err) {
			log.error(err)
			return false
		}
	}

	async fetchCoordinates(
		address: string,
	): Promise<{ lat: number; lng: number } | null> {
		const r: GeoJsonResponse = await (
			await fetch(`http://${this.#host}:${this.#port}/api/?q=${address}`)
		).json()
		if (r.features.length <= 0) return null
		return {
			lat: r.features[0].geometry.coordinates[1],
			lng: r.features[0].geometry.coordinates[0],
		}
	}
}
