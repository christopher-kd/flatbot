/**
 * Income-restriction detection for Berlin apartment listings.
 *
 * Three buckets, in order of cost to the applicant:
 *   "free"           No income restriction ("ohne WBS" / free-financed).
 *   "income-checked" Landlord verifies income directly ("Einkommensprüfung"
 *                    / "einkommensorientierte Miete"), no certificate needed.
 *   "wbs-required"   Formal Wohnberechtigungsschein from the Bezirksamt
 *                    required ("amtlicher WBS", or bare "WBS 100/140/...").
 *                    Takes weeks to obtain.
 *
 * WBS level = how far income may exceed the federal limit (§9 Abs. 2 WoFG):
 *   100 -> at/under, 140 -> +40%, 160 -> +60%, 180 -> +80%, 220 -> +120%.
 *
 * Level phrasing in titles:
 *   "WBS 100-140" / "100 bis 140"  -> every level in [100,140]      = 100,140
 *   "WBS bis 140"  (up to)         -> every level from min up to 140 = 100,140
 *   "WBS größer140-180" (above)    -> range minus excluded level    = 160,180
 *   "WBS 160 oder 180" / "160/180" -> exactly the named levels      = 160,180
 *
 * Title-only signal — parses German phrasing from Stadt und Land / HOWOGE.
 */

import type {
	Restriction,
	Restrictions,
	SpecialNeed,
	WBSLevel,
} from "../types"

const WBS_LEVELS = [100, 140, 160, 180, 220] as const

const WBS_LEVEL_SET: ReadonlySet<number> = new Set(WBS_LEVELS)
const MIN_LEVEL = WBS_LEVELS[0]

/**
 * "Besonderer Wohnbedarf" (special housing need) marks a WBS sub-category
 * ("WBS mit besonderem Wohnbedarf") - a flat with it is a WBS flat:
 *   "required" -> only tenants WITH it qualify ("mit besonderem Wohnbedarf")
 *   "either"   -> open with OR without ("mit und ohne besonderem Wohnbedarf")
 *   null       -> not mentioned (standard allocation)
 */
export interface RestrictionInfo {
	/** Which of the three eligibility buckets the listing falls into. */
	restriction: Restriction
	/** WBS level(s) derivable from the title, ascending and de-duplicated. */
	levels: WBSLevel[]
	/** Besonderer-Wohnbedarf status; non-null implies a WBS flat. */
	specialNeed: SpecialNeed
	/** Short explanation of the decision — handy for debugging the scraper. */
	reason: string
}

// --- signal regexes -------------------------------------------------------

// Explicit "no restriction": "ohne WBS" / "kein WBS". Note this does NOT fire
// on "mit und ohne besonderen Wohnbedarf" since "ohne" isn't followed by "wbs".
const FREE = /\b(ohne|kein(?:en)?)\s+wbs\b/
const FREIFINANZIERT = /\bfrei\s?finanziert\b/

// "amtlicher WBS" -> definitely a formal certificate.
const AMTLICH = /amtlich\w*\s+wbs|wbs[^.]{0,40}amtlich/

// The token "WBS" (incl. "WBS220" with no space).
const WBS_TOKEN = /\bwbs(?:\b|\d)/

// Landlord-side income check, no formal certificate implied.
const INCOME_CHECK =
	/einkommensorientiert|einkommenspr[üu]fung|income[\s-]?check/

// Spelled-out "Wohnberechtigungsschein(e/s)" — collapse to "wbs" up front so
// every regex below (all keyed on the "wbs" token) picks it up for free.
const WOHNBERECHTIGUNGSSCHEIN = /wohnberechtigungsschein\w*/g

function normalizeWbsMentions(t: string): string {
	return t.replace(WOHNBERECHTIGUNGSSCHEIN, "wbs")
}

/**
 * Classifies a title into one of the three buckets, in first-match-wins
 * precedence:
 *   1. "ohne WBS" / "freifinanziert"        -> free
 *   2. "amtlicher WBS"                      -> wbs-required (explicit cert)
 *   3. "Einkommensprüfung" / "income check" -> income-checked (wins over a
 *      bare WBS tier - the number there just names the income band checked)
 *   4. bare "WBS ..." mention               -> wbs-required (assume cert,
 *                                              confirm on detail page)
 *   5. nothing                              -> free
 */
export function classifyRestriction(title: string): RestrictionInfo {
	const t = normalizeWbsMentions((title ?? "").toLowerCase())
	const specialNeed = getSpecialNeed(t)
	// Small helper so every branch carries restriction + levels + specialNeed.
	const out = (
		restriction: Restriction,
		levels: WBSLevel[],
		reason: string,
	): RestrictionInfo => ({
		restriction,
		levels,
		specialNeed,
		reason,
	})

	if (!t.trim()) return out("free", [], "empty title")

	const levels = getWbsLevels(t)

	// 1) explicit negatives
	if (FREE.test(t)) return out("free", [], 'explicit "ohne WBS"')
	if (FREIFINANZIERT.test(t)) return out("free", [], "freifinanziert")

	// 2) explicit formal certificate
	if (AMTLICH.test(t)) {
		return out("wbs-required", levels, "amtlicher WBS (formal certificate)")
	}

	// 3) landlord income check — wins over a bare WBS tier mention
	if (INCOME_CHECK.test(t)) {
		return out(
			"income-checked",
			levels,
			/einkommensorientiert/.test(t)
				? "einkommensorientierte Miete (landlord income check)"
				: "Einkommensprüfung (landlord income check)",
		)
	}

	// 4) bare WBS mention
	if (WBS_TOKEN.test(t)) {
		return out(
			"wbs-required",
			levels,
			levels.length
				? "bare WBS tier — amtlich vs. income check not stated " +
						"anywhere; treated as wbs-required (conservative)"
				: "WBS mentioned, no level stated",
		)
	}

	// 5) no signal
	return out("free", [], "no restriction signal")
}

/**
 * Extract WBS level(s) named in a title. Exposed separately, but
 * classifyRestriction() already calls it for you.
 */
export function getWbsLevels(title: string): WBSLevel[] {
	if (!title) return []
	const t = normalizeWbsMentions(title.toLowerCase())
	const hasWbs = /wbs/.test(t)
	const found = new Set<WBSLevel>()
	const excluded = new Set<number>() // levels marked "größer X" / "> X"

	// (a) "above X": "größer 140", "größer140", ">140", "über 140" -> exclude X.
	for (const m of t.matchAll(
		/(?:gr(?:ö|oe)(?:ß|ss)er|über|ueber|>)\s*(?:als\s*)?(\d{3})/g,
	)) {
		excluded.add(Number(m[1]))
	}

	// (b) two-endpoint ranges: "100-140", "100 bis 140", "180 - 220", "100/140".
	for (const m of t.matchAll(/(\d{3})\s*(?:bis|to|–|-|\/)\s*(\d{3})/g)) {
		const a = Number(m[1])
		const b = Number(m[2])
		if (
			WBS_LEVEL_SET.has(a) ||
			WBS_LEVEL_SET.has(b) ||
			isWbsContext(t, m.index)
		) {
			addRange(found, Math.min(a, b), Math.max(a, b))
		}
	}

	// (c) open "up to": "bis 140" -> [MIN_LEVEL..140]. Gated on a WBS mention,
	//     guarded against "bis 100 m²" noise.
	if (hasWbs) {
		for (const m of t.matchAll(
			/\bbis\s+(?:wbs\s*)?(\d{3})(?!\s*(?:m²|qm|m2|€|eur))/g,
		)) {
			const n = Number(m[1])
			if (WBS_LEVEL_SET.has(n)) addRange(found, MIN_LEVEL, n)
		}
	}

	// (d) direct "WBS 140", "WBS-100", "WBS220".
	for (const m of t.matchAll(/wbs[\s-]*(\d{3})/g)) {
		const lvl = Number(m[1])
		if (WBS_LEVEL_SET.has(lvl)) found.add(lvl as WBSLevel)
	}

	// (e) alternatives near a WBS mention: "WBS 160 oder WBS 180", "WBS 100/140".
	const wbsIdx = t.indexOf("wbs")
	if (wbsIdx !== -1) {
		// local window avoids m²/rent numbers
		const win = t.slice(wbsIdx, wbsIdx + 45)
		for (const m of win.matchAll(/(\d{3})/g)) {
			const lvl = Number(m[1])
			if (WBS_LEVEL_SET.has(lvl)) found.add(lvl as WBSLevel)
		}
	}

	for (const x of excluded) found.delete(x as WBSLevel)
	return [...found].sort((a, b) => a - b)
}

/** Add every valid level within [lo, hi] (inclusive) to the set. */
function addRange(set: Set<WBSLevel>, lo: number, hi: number): void {
	for (const lvl of WBS_LEVELS) if (lvl >= lo && lvl <= hi) set.add(lvl)
}

/**
 * Detect "besonderer Wohnbedarf" status from the title.
 *   "either"   <- "mit und ohne ... Wohnbedarf" (also "mit oder ohne")
 *   "required" <- "mit ... Wohnbedarf" with no "und/oder ohne"
 *   null       <- no "Wohnbedarf" mention
 * "either" is checked first because it contains a "mit ..." substring too.
 */
export function getSpecialNeed(title: string): SpecialNeed {
	const t = (title ?? "").toLowerCase()
	if (!/wohnbedarf/.test(t)) return null
	if (/\b(und|oder)\s+ohne\s+(?:besonder\w*\s+)?wohnbedarf/.test(t))
		return "either"
	if (/\bmit\s+(?:besonder\w*\s+)?wohnbedarf/.test(t)) return "required"
	// e.g. "bis 140 WBS, besonderer Wohnbedarf"
	if (/\bbesonder\w*\s+wohnbedarf/.test(t)) return "required"
	return null
}

/** Heuristic: is a "100 bis 140" range close to a WBS/income-check keyword? */
function isWbsContext(
	lowerTitle: string,
	atIndex: number | undefined,
): boolean {
	if (atIndex == null) return false
	const window = lowerTitle.slice(Math.max(0, atIndex - 30), atIndex)
	return /wbs|einkommenspr[üu]fung|einkommensorientiert/.test(window)
}

// --- thin boolean helpers (optional convenience) --------------------------

/** True if a formal WBS certificate is required. */
export function requiresFormalWbs(title: string): boolean {
	return classifyRestriction(title).restriction === "wbs-required"
}

/** True if there is ANY income restriction (income check OR formal WBS). */
export function isIncomeRestricted(title: string): boolean {
	return classifyRestriction(title).restriction !== "free"
}

/** Builds the `Restrictions` object every listing carries, from its title. */
export function restrictionFromTitle(title: string): Restrictions {
	const { restriction, levels, specialNeed } = classifyRestriction(title)
	return {
		kind: restriction,
		wbsLevels: levels,
		wbsSpecialNeed: specialNeed,
	}
}
