import { describe, expect, test } from "bun:test"
import { parseMapPinCoordinates } from "../scraper/adapters/InBerlinWohnen"

describe("parseMapPinCoordinates", () => {
	test("parses a valid, distinct lat/lon pair", () => {
		const wireClick =
			'$dispatch(\'flatClicked\', {"lat":"52.54665322","lon":"13.50150560","id":20135});'

		expect(parseMapPinCoordinates(wireClick)).toEqual({
			lat: 52.54665322,
			lng: 13.5015056,
		})
	})

	test("drops a pin where lat and lon are identical", () => {
		const wireClick =
			'$dispatch(\'flatClicked\', {"lat":"52.55479465","lon":"52.55479465","id":19603});'

		expect(parseMapPinCoordinates(wireClick)).toBeUndefined()
	})

	test("throws when no JSON object is present in the attribute", () => {
		const wireClick = "$dispatch('flatClicked');"

		expect(() => parseMapPinCoordinates(wireClick)).toThrow()
	})
})
