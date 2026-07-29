import type { Collection } from "mongodb"
import type { ArchivedApartmentListing, StoredApartmentListing } from "../types"
import MongoDatabaseClient from "./MongoDatabaseClient"
import type ListingRepository from "./repository/ListingRepository"
import MongoListingRepository from "./repository/MongoListingRepository"

export default async function createListingRepository(): Promise<{
	dbClient: MongoDatabaseClient
	listingRepository: ListingRepository
}> {
	const dbClient = new MongoDatabaseClient()
	const mongoClient = await dbClient.connect()
	const db = await dbClient.getDb()

	const listingCollection: Collection<StoredApartmentListing> =
		db.collection("listings")
	const archiveCollection: Collection<ArchivedApartmentListing> =
		db.collection("listings_archive")
	const listingRepository = new MongoListingRepository(
		mongoClient,
		listingCollection,
		archiveCollection,
	)

	return { dbClient, listingRepository }
}
