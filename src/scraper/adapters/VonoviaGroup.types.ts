export default interface VonoviaGroupResponse {
	paging: {
		info: {
			count: number
			limit: number
		}
	}
	results: Array<{
		wrk_id: string
		titel: string
		strasse: string
		plz: string
		ort: string
		preis: number
		groesse: number
		anzahl_zimmer: number
		preview_img_url: string
		imageUrls: string[]
		slug: string
		vermarktungsart_kauf: string
		vermarktungsart_miete: string
		is_on_favlist: string
		object_viewed: boolean
		tour_link_360: string
		has_grundriss: boolean
		lat: number
		lng: number
	}>
}
