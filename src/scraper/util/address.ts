type AddressField =
	| "street"
	| "houseNumber"
	| "postalCode"
	| "city"
	| "precinct"

type Address = Partial<Record<AddressField, string>>

// Per-field regex fragments. street/city/precinct are lazy `.+?` (bounded by
// the next literal/field); houseNumber covers "5", "35A", "16 C", "65/I",
// "55-57".
const FIELD_PATTERNS: Record<AddressField, string> = {
	street: ".+?",
	houseNumber: "\\d+(?:\\s?[A-Za-z]|/[A-Za-z0-9]+|-\\d+[A-Za-z]?)?",
	postalCode: "\\d{4,5}",
	city: ".+?",
	precinct: ".+?",
}

const METACHARS = /[.*+?^${}()|[\]\\]/g
const TOKEN = /\{([a-zA-Z_]+)\}|([^{}]+)/g
const WHITESPACE_RUN = /\s+|[^\s]+/g

interface CompiledTemplate {
	regex: RegExp
	fields: AddressField[]
}

function isAddressField(name: string): name is AddressField {
	return Object.hasOwn(FIELD_PATTERNS, name)
}

function escapeLiteral(text: string): string {
	return text.replace(METACHARS, "\\$&")
}

// Literal template text -> regex fragment: whitespace becomes `\s+`
// (tolerates inconsistent scraped spacing), everything else is escaped.
function compileLiteral(text: string): string {
	let out = ""
	for (const chunk of text.match(WHITESPACE_RUN) ?? []) {
		out += /^\s/.test(chunk) ? "\\s+" : escapeLiteral(chunk)
	}
	return out
}

function compileTemplate(template: string): CompiledTemplate {
	const fields: AddressField[] = []
	let pattern = ""
	let consumedLength = 0

	for (const match of template.matchAll(TOKEN)) {
		consumedLength += match[0].length
		const [, placeholder, literal] = match
		if (placeholder !== undefined) {
			if (!isAddressField(placeholder)) {
				const knownFields = Object.keys(FIELD_PATTERNS).join(", ")
				throw new Error(
					`Unknown address field "{${placeholder}}" in template ` +
						`"${template}". Known fields: ${knownFields}`,
				)
			}
			fields.push(placeholder)
			pattern += `(${FIELD_PATTERNS[placeholder]})`
		} else {
			pattern += compileLiteral(literal ?? "")
		}
	}

	if (consumedLength !== template.length) {
		throw new Error(`Malformed template (stray "{" or "}"): "${template}"`)
	}

	return { regex: new RegExp(`^${pattern}$`), fields }
}

const templateCache = new Map<string, CompiledTemplate>()

function getCompiledTemplate(template: string): CompiledTemplate {
	let compiled = templateCache.get(template)
	if (!compiled) {
		compiled = compileTemplate(template)
		templateCache.set(template, compiled)
	}
	return compiled
}

/**
 * Parses `input` against a `template` of `{fieldName}` placeholders
 * (street, houseNumber, postalCode, city, precinct). Only fields present
 * in the template appear on the result.
 *
 *   parseAddress("Genslerstraße 42, 13055 Berlin",
 *     "{street} {houseNumber}, {postalCode} {city}")
 *   // => { street: "Genslerstraße", houseNumber: "42",
 *   //      postalCode: "13055", city: "Berlin" }
 *
 * Two adjacent free-text fields (street/city/precinct) with only
 * whitespace between them are ambiguous — the template needs a literal or
 * specific-shaped field between them.
 */
function parseAddress(input: string, template: string): Address {
	const raw = input.trim()
	const { regex, fields } = getCompiledTemplate(template)
	const match = raw.match(regex)
	if (!match) {
		throw new Error(`Address "${raw}" does not match template "${template}"`)
	}
	const result: Address = {}
	fields.forEach((field, i) => {
		result[field] = match[i + 1].trim()
	})
	return result
}

export { parseAddress }
