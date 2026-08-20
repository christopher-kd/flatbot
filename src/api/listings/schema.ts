import { z } from "zod"
import { RESTRICTION_KINDS } from "../types"

export const MONGO_SORT_FIELDS = {
	totalRentEur: "costs.totalRentEur",
	rooms: "rooms",
	spaceQm: "spaceQm",
	firstSeenAt: "firstSeenAt",
} as const

export type MongoSortField = keyof typeof MONGO_SORT_FIELDS

export type SortField = MongoSortField | "distance"

const scalarString = z
	.union([z.string(), z.array(z.string())])
	.optional()
	.transform((v) => {
		const s = Array.isArray(v) ? v[0] : v
		if (s === undefined) return undefined
		const trimmed = s.trim()
		return trimmed === "" ? undefined : trimmed
	})

const optionalNumber = scalarString
	.refine((v) => v === undefined || Number.isFinite(Number(v)), {
		message: "must be a number",
	})
	.transform((v) => (v === undefined ? undefined : Number(v)))

const optionalInteger = optionalNumber.refine(
	(v) => v === undefined || Number.isInteger(v),
	{
		message: "must be an integer",
	},
)

const optionalBoolean = scalarString
	.refine((v) => v === undefined || v === "true" || v === "false", {
		message: 'must be "true" or "false"',
	})
	.transform((v) => (v === undefined ? undefined : v === "true"))

type IssueContext = {
	addIssue: (issue: {
		code: "custom"
		path: (string | number)[]
		message: string
	}) => void
}

function checkRange(
	ctx: IssueContext,
	minKey: string,
	min: number | undefined,
	maxKey: string,
	max: number | undefined,
) {
	if (min !== undefined && max !== undefined && min > max) {
		ctx.addIssue({
			code: "custom",
			path: [maxKey],
			message: `${maxKey} must be greater than or equal to ${minKey}`,
		})
	}
}

function toStringArray(v: unknown): string[] {
	const values = v === undefined ? [] : Array.isArray(v) ? v : [v]
	return values
		.flatMap((s) => String(s).split(","))
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

const stringList = z.preprocess(toStringArray, z.array(z.string()))

export const listingsQuerySchema = z
	.object({
		minPrice: optionalNumber,
		maxPrice: optionalNumber,
		minRooms: optionalNumber,
		maxRooms: optionalNumber,
		minSpace: optionalNumber,
		maxSpace: optionalNumber,
		organization: stringList,
		restrictionKind: z.preprocess(
			toStringArray,
			z.array(z.enum(RESTRICTION_KINDS)),
		),
		wbsLevel: z.preprocess(toStringArray, z.array(z.coerce.number())),
		wheelchair: optionalBoolean,
		barrierFree: optionalBoolean,
		senior: optionalBoolean,
		newBuilding: optionalBoolean,
		lat: optionalNumber,
		lng: optionalNumber,
		radiusKm: optionalNumber.refine((v) => v === undefined || v > 0, {
			message: "must be greater than 0",
		}),
		sort: scalarString,
		limit: optionalInteger,
		offset: optionalInteger,
	})
	.superRefine((data, ctx) => {
		checkRange(ctx, "minPrice", data.minPrice, "maxPrice", data.maxPrice)
		checkRange(ctx, "minRooms", data.minRooms, "maxRooms", data.maxRooms)
		checkRange(ctx, "minSpace", data.minSpace, "maxSpace", data.maxSpace)

		const geoFields = { lat: data.lat, lng: data.lng, radiusKm: data.radiusKm }
		const missingGeoFields = Object.entries(geoFields)
			.filter(([, v]) => v === undefined)
			.map(([key]) => key)
		const geoComplete = missingGeoFields.length === 0

		if (missingGeoFields.length > 0 && missingGeoFields.length < 3) {
			for (const field of missingGeoFields) {
				ctx.addIssue({
					code: "custom",
					path: [field],
					message: "lat, lng, and radiusKm must all be provided together",
				})
			}
		}

		if (!data.sort) return

		const [field, dir] = data.sort.split(":")
		const isKnownField =
			field === "distance" ||
			(field !== undefined && Object.hasOwn(MONGO_SORT_FIELDS, field))
		if (!isKnownField) {
			ctx.addIssue({
				code: "custom",
				path: ["sort"],
				message: `unknown sort field "${field}"`,
			})
		}

		const hasDir = dir !== undefined
		const isValidDir = dir === "asc" || dir === "desc"
		if (hasDir && !isValidDir) {
			ctx.addIssue({
				code: "custom",
				path: ["sort"],
				message: 'sort direction must be "asc" or "desc"',
			})
		}

		if (field === "distance" && !geoComplete) {
			ctx.addIssue({
				code: "custom",
				path: ["sort"],
				message: "sort=distance requires lat, lng, and radiusKm",
			})
		}
	})
