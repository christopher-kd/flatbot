export interface GeoJsonResponse {
	type: "FeatureCollection"
	features: Feature[]
}

export interface Feature {
	type: "Feature"
	properties: FeatureProperties
	geometry: Geometry
}

export interface FeatureProperties {
	osm_type: string
	osm_id: number
	osm_key: string
	osm_value: string
	type: string
	name: string
	country: string
	countrycode: string
	extent?: [number, number, number, number]
	county?: string
	state?: string
	postcode?: string
	street?: string
	locality?: string
	district?: string
	city?: string
}

export interface Geometry {
	type: "Point"
	coordinates: [number, number]
}
