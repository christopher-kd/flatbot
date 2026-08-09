import { exit } from "node:process"
import createListingRepository from "../db/createListingRepository"
import log from "../logger/logger"
import Berlinovo from "./adapters/Berlinovo"
import Degewo from "./adapters/Degewo"
import DeutscheWohnen from "./adapters/DeutscheWohnen"
import Gesobau from "./adapters/Gesobau"
import Gewobag from "./adapters/Gewobag"
import Howoge from "./adapters/Howoge"
import InBerlinWohnenScraper from "./adapters/InBerlinWohnen"
import StadtUndLand from "./adapters/StadtUndLand"
import Vonovia from "./adapters/Vonovia"
import Wbm from "./adapters/Wbm"
import PhotonClient from "./PhotonClient"
import type Scraper from "./Scraper"
import ScraperRunner from "./ScraperRunner"

const { dbClient, listingRepository } = await createListingRepository()

// Primary scraping sources
const directScrapers: Scraper[] = [
	new Howoge(),
	new StadtUndLand(),
	new Degewo(),
	new Gewobag(),
	new Gesobau(),
	new Berlinovo(),
	new Wbm(),
	new Vonovia(),
	new DeutscheWohnen(),
]

// Secondary source for merging data of kommunale Wohnbaugesellschaften with
// data from InBerlinWohnen
const aggregatorScraper = new InBerlinWohnenScraper()

const runner = new ScraperRunner({
	directScrapers,
	aggregatorScraper,
	listingRepository,
	dbClient,
	photonClient: new PhotonClient(),
})

runner
	.run()
	.then(() => exit())
	.catch((err) => {
		log.error(err)
		exit(1)
	})
