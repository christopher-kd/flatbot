import VonoviaGroupScraper from "./VonoviaGroupScraper"

export default class DeutscheWohnen extends VonoviaGroupScraper {
	constructor() {
		super(
			"Deutsche Wohnen",
			"https://www.deutsche-wohnen.com/api/deuwo-real-estate/list",
			"https://www.deutsche-wohnen.com/mieten/mietangebote/",
		)
	}
}
