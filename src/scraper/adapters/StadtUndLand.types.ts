export type DistrictData = {
  district: string;
  subdistrict: string[];
}[];

export interface StadtUndLandReponse {
	data: Array<{
		headline: string
		address: {
			postal_code: string
			city: string
			street: string
			house_number: string
			precinct: string
		}
		details: {
			immoNumber: string
			immoType: string
			immoSubType: string
			livingSpace: string
			rooms: string
			wheelchairFriendly: boolean
			seniorsFriendly: boolean
			barrierFree: boolean
		}
		costs: {
			coldRent: string
			warmRent: string
			additionalCosts: string
			heatingCosts: string
			totalRent: string
			deposit: string
			discount: string
		}
		image: {
			filename: string
			alt: string
			format: string
		}
	}>
	count: number
}
