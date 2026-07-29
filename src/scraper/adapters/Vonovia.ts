import VonoviaGroupScraper from "./VonoviaGroupScraper"

export default class Vonovia extends VonoviaGroupScraper {
	constructor() {
		super(
			"Vonovia",
			"https://www.vonovia.de/api/real-estate/list",
			"https://vonovia.de/zuhause-finden/immobilien/",
		)
	}
}
