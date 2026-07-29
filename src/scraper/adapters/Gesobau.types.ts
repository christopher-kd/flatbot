type GesobauResponse = ListingItem[]

interface ListingItem {
	uid: number
	title: string
	detail: string
	lat: number
	lng: number
	raw: {
		id: string
		type: string
		site: string
		typo3Context_stringS: string
		siteHash: string
		domain_stringS: string
		uid: number
		pid: number
		variantId: string
		created: string
		changed: string
		access: string[]
		title: string
		titleExact: string
		content: string
		contentExact: string
		teaser: string
		objekt_nr_extern_stringS: string
		url: string
		objektart_stringS: string
		nutzungsart_stringS: string
		kanal_stringM: string[]
		adresse_stringS: string
		ort_stringS: string
		plz_stringS: string
		region_stringM: string[]
		location_stringM: string[]
		zimmer_intS?: number
		wohnflaeche_floatS?: number
		gesamtflaeche_floatS?: number
		warmmiete_floatS?: number
		sozialwohnung_boolS?: boolean
		seniorengerecht_boolS?: boolean
		rollstuhlgerecht_boolS?: boolean
		barrierefrei_boolS?: boolean
		terrasse_boolS?: boolean
		balkonFacette_boolS?: boolean
		wanne_boolS?: boolean
		ebk_boolS?: boolean
		fahrstuhl_boolS?: boolean
		keinEg_boolS?: boolean
		gartennutzung_boolS?: boolean
		fuerSenioren_boolS?: boolean
		fuerStudierende_boolS?: boolean
		noWbs_boolS?: boolean
		keller_boolS?: boolean
		lat_floatS?: number
		lon_floatS?: number
		_version_?: number
		indexed?: string
		score?: number
	}
	image?: {
		figure: {
			media: {
				type: string
				image: {
					src: string
					width: number
					height: number
					srcNoscript: string
					domData: {
						src: string
						srcset: string
						sizes: string
					}
					classes: string
					alt: string
					isLetterboxed?: boolean
					aspectRatio?: string
					orientation?: string
				}
			}
			caption: string
			copyright: string
			link: unknown[]
			lightboxsrc: string
			zoomButtonText: string
		}
	}
}

export default GesobauResponse
