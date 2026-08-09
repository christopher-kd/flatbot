import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { checkListingLiveness } from "../scraper/liveness"
import type { ApartmentListing, Organization } from "../types"

type LivenessCheckTarget = Pick<
	ApartmentListing,
	"organization" | "fullUrl" | "propertyId"
>

function makeTarget(
	organization: Organization,
	fullUrl = "https://example.com/listing/1",
): LivenessCheckTarget {
	return { organization, fullUrl, propertyId: "1" }
}

// Response.url is normally set by the real fetch implementation from the
// final request URL (after redirects) - it's read-only, so a mocked
// Response needs it force-set via defineProperty to simulate a 404 redirect.
function makeResponse(
	opts: { status?: number; url?: string; body?: string } = {},
): Response {
	const response = new Response(opts.body ?? "", { status: opts.status ?? 200 })
	if (opts.url !== undefined) {
		Object.defineProperty(response, "url", {
			value: opts.url,
			configurable: true,
		})
	}
	return response
}

afterEach(() => {
	mock.restore()
})

describe("checkListingLiveness", () => {
	test("returns not-implemented for orgs with no real check, without fetching", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
		const orgsWithoutACheck: Organization[] = [
			"Stadt und Land",
			"Gewobag",
			"WBM",
			"inberlinwohnen",
		]

		for (const organization of orgsWithoutACheck) {
			const result = await checkListingLiveness(makeTarget(organization))
			expect(result).toBe("not-implemented")
		}
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	describe("degewo", () => {
		test("inactive when the page fetch isn't ok", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 500 }),
			)
			const result = await checkListingLiveness(makeTarget("degewo"))
			expect(result).toBe("inactive")
		})

		test("inactive when redirected to /404", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ url: "https://degewo.de/immosuche/details/404" }),
			)
			const result = await checkListingLiveness(makeTarget("degewo"))
			expect(result).toBe("inactive")
		})

		test("inactive when the page shows a deactivated marker despite 200", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({
					body: '<div class="c-copy"><h2 class="c-headline c-headline--h2">Diese Wohnung ist nicht mehr verfügbar</h2></div>',
				}),
			)
			const result = await checkListingLiveness(makeTarget("degewo"))
			expect(result).toBe("inactive")
		})

		test("active on a normal 200 page", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ body: "<div>Wohnung verfügbar</div>" }),
			)
			const result = await checkListingLiveness(makeTarget("degewo"))
			expect(result).toBe("active")
		})
	})

	describe("HOWOGE", () => {
		test("inactive when the page fetch isn't ok", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 500 }),
			)
			const result = await checkListingLiveness(makeTarget("HOWOGE"))
			expect(result).toBe("inactive")
		})

		test("inactive when redirected to /404", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ url: "https://howoge.de/wohnungen/404" }),
			)
			const result = await checkListingLiveness(makeTarget("HOWOGE"))
			expect(result).toBe("inactive")
		})

		test("active on 200 regardless of body content", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ body: "<p>irrelevant</p>" }),
			)
			const result = await checkListingLiveness(makeTarget("HOWOGE"))
			expect(result).toBe("active")
		})
	})

	describe("status-only orgs (Vonovia, GESOBAU, Deutsche Wohnen)", () => {
		test("active when the fetch is ok", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 200 }),
			)
			const result = await checkListingLiveness(makeTarget("GESOBAU"))
			expect(result).toBe("active")
		})

		test("inactive when the fetch isn't ok", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 404 }),
			)
			const result = await checkListingLiveness(makeTarget("GESOBAU"))
			expect(result).toBe("inactive")
		})

		test("Vonovia and Deutsche Wohnen route through the same status-only check", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 200 }),
			)
			expect(await checkListingLiveness(makeTarget("Vonovia"))).toBe("active")
			expect(await checkListingLiveness(makeTarget("Deutsche Wohnen"))).toBe(
				"active",
			)
		})
	})

	describe("Berlinovo", () => {
		test("rewrites the host to www.berlinovo.de before checking status", async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 200 }),
			)
			const result = await checkListingLiveness(
				makeTarget("Berlinovo", "https://berlinovo.de/de/wohnung/123"),
			)

			expect(result).toBe("active")
			expect(fetchSpy.mock.calls[0]?.[0]).toBe(
				"https://www.berlinovo.de/de/wohnung/123",
			)
		})

		test("inactive when the rewritten fetch isn't ok", async () => {
			spyOn(globalThis, "fetch").mockResolvedValue(
				makeResponse({ status: 404 }),
			)
			const result = await checkListingLiveness(
				makeTarget("Berlinovo", "https://berlinovo.de/de/wohnung/123"),
			)
			expect(result).toBe("inactive")
		})
	})

	test("throws for an organization with no dispatch case", async () => {
		const target = makeTarget("unknown-org" as unknown as Organization)

		let thrown: unknown
		try {
			await checkListingLiveness(target)
		} catch (err) {
			thrown = err
		}

		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toContain("No liveness check implemented")
	})
})
