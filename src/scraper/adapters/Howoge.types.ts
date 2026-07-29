export type HowogeFeature =
	| "WBS erforderlich"
	| "Bad mit Dusche"
	| "offene Küche"
	| "Fußbodenheizung"
	| "Zentralheizung"
	| "Aufzug"
	| "KabelTV-Anschluss"
	| "Mieterkeller"
	| "barrierefrei"
	| "Abstellraum in der Wohnung"
	| "Terrasse"
	| "Balkon/Loggia"
	| "Studentisches Wohnen"
	| "Bad mit Fenster"
	| "Teilmöbliert"
	| "abgezogene Dielen"
	| "Bad mit Badewanne"
	| "Linoleum Fußboden"
	| "Laminat-Fußboden"
	| "rollstuhlgerecht"

export default interface HowogeResponse {
	immocount: number
	teasercount: number
	immoobjects: Array<{
		uid: number
		title: string
		image: string
		district: string
		rent: number
		area: number
		rooms: number
		wbs: string
		features: Array<string | HowogeFeature>
		coordinates: {
			lat: string
			lng: string
		}
		icon: string
		link: string
		favorite: boolean
		notice: string
	}>
	projectteaser: Array<{
		title: string
		address: string
		indate: string
		rooms: string
		coordinates: {
			lat: string
			lng: string
		}
		link: string
		image: string
	}>
	badges: unknown[]
}
