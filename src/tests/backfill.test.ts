import { describe, expect, test } from "bun:test"
import { fillMissingCoordinates } from "../scraper/backfill"
import type PhotonClient from "../scraper/PhotonClient"
import type {
	ApartmentListing,
	ApartmentListingLocation,
	ApartmentListingLocationCoordinates,
} from "../types"

function makeListing(
	overrides: Partial<ApartmentListing> = {},
): ApartmentListing {
	return {
		listingId: "WBM:1",
		propertyId: "1",
		organization: "WBM",
		lastSeenAt: Date.now(),
		title: "Test listing",
		fullUrl: "https://example.com/1",
		location: {
			postalCode: "12345",
			city: "Berlin",
			street: "Teststr.",
			houseNumber: "1",
		},
		spaceQm: 50,
		rooms: 2,
		restrictions: { kind: "free" },
		costs: {},
		images: [],
		...overrides,
	}
}

function makePhotonClient(
	fetchCoordinates: (
		address: string,
	) => Promise<ApartmentListingLocationCoordinates | null>,
): PhotonClient {
	return { fetchCoordinates } as unknown as PhotonClient
}

const addressFor = (location: ApartmentListingLocation) =>
	`${location.street} ${location.houseNumber}`

describe("fillMissingCoordinates", () => {
	test("only targets listings with coordinates === undefined", async () => {
		const untouched = makeListing({
			listingId: "WBM:1",
			location: { ...makeListing().location, coordinates: null },
		})
		const alreadySet = makeListing({
			listingId: "WBM:2",
			location: {
				...makeListing().location,
				coordinates: { type: "Point", coordinates: [2, 1] },
			},
		})
		const target = makeListing({
			listingId: "WBM:3",
			location: { ...makeListing().location },
		})

		const requestedAddresses: string[] = []
		const photonClient = makePhotonClient(async (address) => {
			requestedAddresses.push(address)
			return { type: "Point", coordinates: [13.4, 52.5] }
		})

		await fillMissingCoordinates(
			photonClient,
			[untouched, alreadySet, target],
			addressFor,
		)

		expect(requestedAddresses).toEqual(["Teststr. 1"])
		expect(untouched.location.coordinates).toBeNull()
		expect(alreadySet.location.coordinates).toEqual({
			type: "Point",
			coordinates: [2, 1],
		})
		expect(target.location.coordinates).toEqual({
			type: "Point",
			coordinates: [13.4, 52.5],
		})
	})

	test("writes null (not undefined) when Photon confirms zero results", async () => {
		const target = makeListing()
		const photonClient = makePhotonClient(async () => null)

		await fillMissingCoordinates(photonClient, [target], addressFor)

		expect(target.location.coordinates).toBeNull()
	})

	test("a fetch failure leaves coordinates undefined so it gets backfilled, not null", async () => {
		const target = makeListing()
		const photonClient = makePhotonClient(async () => {
			throw new Error("network error")
		})

		await fillMissingCoordinates(photonClient, [target], addressFor)

		expect(target.location.coordinates).toBeUndefined()
	})

	test("one listing's failure doesn't stop others from being filled", async () => {
		const failing = makeListing({
			listingId: "WBM:1",
			location: { ...makeListing().location, street: "Failstr." },
		})
		const succeeding = makeListing({
			listingId: "WBM:2",
			location: { ...makeListing().location, street: "Okstr." },
		})

		const photonClient = makePhotonClient(async (address) => {
			if (address.startsWith("Failstr.")) throw new Error("boom")
			return { type: "Point", coordinates: [13.4, 52.5] }
		})

		await fillMissingCoordinates(
			photonClient,
			[failing, succeeding],
			addressFor,
		)

		expect(failing.location.coordinates).toBeUndefined()
		expect(succeeding.location.coordinates).toEqual({
			type: "Point",
			coordinates: [13.4, 52.5],
		})
	})
})
