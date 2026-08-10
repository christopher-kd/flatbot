import type { ApartmentListingLocationCoordinates } from "../../types"

export function geoJSONFrom(
	lng: number,
	lat: number,
): ApartmentListingLocationCoordinates {
	return { type: "Point", coordinates: [lng, lat] }
}
