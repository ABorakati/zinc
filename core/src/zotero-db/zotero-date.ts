// English-locale port of Zotero.Date.strToDate / parseEDTF / strToMultipart (zotero/utilities date.js), so the
// "YYYY-MM-DD <original text>" value written into zotero.sqlite is the one Zotero itself would store.
// Zotero reads the leading sortable part for its Year column and for sorting; "0000-00-00" there means "no year".
// Differences from Zotero: English month names only (Zotero also reads the UI locale's), en-US numeric order (m/d/y).

const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_LONG = [
	"january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];
const MONTH_RE = new RegExp(`(.*)(?:^|[^\\p{L}])(${[...MONTHS_SHORT, ...MONTHS_LONG].join("|")})[^ ]*(?: (.*)$|$)`, "iu");
const SLASH_RE = /^(.*?)\b([0-9]{1,4})(?:([\-\/\.年])([0-9]{1,2}))?(?:([\-\/\.月])([0-9]{1,4}))?((?:\b|[^0-9]).*?)$/;
const YEAR_RE =
	/^(.*?)\b((?:circa |around |about |c\.? ?)?[0-9]{1,4}(?: ?B\.? ?C\.?(?: ?E\.?)?| ?C\.? ?E\.?| ?A\.? ?D\.?)|[0-9]{3,4})\b(.*?)$/i;
const DAY_RE = /\b([0-9]{1,2})(?:st|nd|rd|th)?\b(.*)/i;

export interface DateParts {
	year?: number | string;
	/** 0-indexed, as in Zotero */
	month?: number;
	day?: number;
}

interface Part {
	part: string;
}

const lpad = (v: string | number, w: number) => String(v).padStart(w, "0");

/** Zotero.Date.strToDate (en-US): the year, 0-indexed month and day found in a free-form date string. */
export function strToDate(input: unknown, now: Date = new Date()): DateParts {
	const date: { year?: number | string; month?: number; day?: number } = {};
	if (typeof input !== "string" && typeof input !== "number") return date;
	const string = String(input).replace(/[\xA0\r\n\s]+/g, " ").trim();
	if (!string) return date;

	let parts: Part[] = [];
	const m = SLASH_RE.exec(string);
	let handled = false;
	if (m && (!m[5] || !m[3] || m[3] === m[5] || (m[3] === "年" && m[5] === "月")) && ((m[2] && m[4] && m[6]) || (!m[1] && !m[7]))) {
		let year: string | undefined;
		let month: string | undefined;
		let day: string | undefined;
		if (m[2]!.length === 3 || m[2]!.length === 4 || m[3] === "年") {
			[year, month, day] = [m[2], m[4], m[6]];
		} else if (m[2] && !m[4] && m[6]) {
			[month, year] = [m[2], m[6]];
		} else {
			[month, day, year] = [m[2], m[4], m[6]]; // en-US: middle-endian
		}
		const longYear = !!year && year.length > 2;
		let y = year ? parseInt(year, 10) : undefined;
		let d = day ? parseInt(day, 10) : undefined;
		let mo = month ? parseInt(month, 10) : undefined;
		if (mo && mo > 12) [d, mo] = [mo, d]; // swap day and month
		if ((!mo || mo <= 12) && (!d || d <= 31)) {
			if (y && y < 100 && !longYear) {
				const cur = now.getFullYear();
				const twoDigit = cur % 100;
				const century = cur - twoDigit;
				y = y <= twoDigit ? century + y : century - 100 + y;
			}
			if (y !== undefined) date.year = y;
			if (d) date.day = d;
			if (mo) date.month = mo - 1;
			parts = [{ part: m[1]! }, { part: m[7]! }];
			handled = true;
		}
	}
	if (!handled) {
		delete date.year;
		delete date.month;
		delete date.day;
		parts = [{ part: string }];
	}

	if (!date.year) {
		for (let i = 0; i < parts.length; i++) {
			const ym = YEAR_RE.exec(parts[i]!.part);
			if (ym) {
				date.year = ym[2];
				parts.splice(i, 1, { part: ym[1]! }, { part: ym[3]! });
				break;
			}
		}
	}
	if (date.month === undefined) {
		const names = [...MONTHS_SHORT, ...MONTHS_LONG];
		for (let i = 0; i < parts.length; i++) {
			const mm = MONTH_RE.exec(parts[i]!.part);
			if (mm) {
				date.month = names.indexOf(mm[2]!.toLowerCase()) % 12;
				parts.splice(i, 1, { part: mm[1]! }, { part: mm[3] ?? "" });
				break;
			}
		}
	}
	if (!date.day) {
		for (let i = 0; i < parts.length; i++) {
			const dm = DAY_RE.exec(parts[i]!.part);
			if (dm) {
				const day = parseInt(dm[1]!, 10);
				if (day <= 31) {
					date.day = day;
					parts.splice(i, 1, { part: "" });
					break;
				}
			}
		}
	}
	if (date.year || date.year === 0) date.year = String(date.year);
	return date;
}

// ---------------------------------------------------------------- EDTF subset (Zotero.Date.parseEDTF)

const BCE = "B\\.?\\s?C\\.?(?:\\s?E\\.?)?";
const CE = "C\\.?\\s?E\\.?|A\\.?\\s?D\\.?";
const BCE_RE = new RegExp(`^${BCE}$`, "i");
const ERA_YEAR_RE = new RegExp(`^(?:(${CE})\\s*)?([0-9]{1,4})(?:\\s*(${BCE}|${CE}))?$`, "i");
const ERA_RANGE_RE = new RegExp(`^(?:(${CE})\\s*)?([0-9]{1,4})(?:\\s*(${BCE}|${CE}))?\\s*-\\s*([0-9]{1,4})(?:\\s*(${BCE}|${CE}))?$`, "i");
const ERA_MARKER_RE = new RegExp(`[0-9]\\s*(?:${BCE}|${CE})|(?:${CE})\\s*[0-9]`, "i");
const ERA_MARKERS_RE = new RegExp(`${BCE}|${CE}`, "gi");
const NEGATIVE_YEAR_RE = /(?:^|\/)-[0-9]/;
const CIRCA_PREFIX_RE = /^(?:~|circa |ca\.? ?|c\. ?|about |around )\s*/i;
const EDTF_CHARS_RE = /^[-0-9T:+Z~?%/\s.]*$/i;
const EDTF_SHAPE_RE = /^-?[0-9]{4}[-0-9~?%]*(\/-?[0-9]{4}[-0-9~?%]*)?$/;

const normalizeDashes = (s: string) => s.replace(/[–—−]/g, "-").replace(/--+/g, "-");
const yearWithEra = (year: string, marker: string) => (BCE_RE.test(marker) ? "-" : "") + year.padStart(4, "0");

function eraToEdtf(str: string): string | false {
	const match = str.match(ERA_RANGE_RE) ?? str.match(ERA_YEAR_RE);
	if (!match) return false;
	const [, prefix, beginYear, beginMarker0, endYear, endMarker] = match;
	if (prefix && beginMarker0) return false;
	const beginMarker = prefix || beginMarker0;
	if (!beginMarker && !endMarker) return false;
	if (/^0+$/.test(beginYear!) || (endYear && /^0+$/.test(endYear))) return false;
	let edtf = yearWithEra(beginYear!, (beginMarker || endMarker)!);
	if (endYear) edtf += "/" + yearWithEra(endYear, (endMarker || beginMarker)!);
	return edtf;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function hasEraNotation(str: string): boolean {
	return NEGATIVE_YEAR_RE.test(str) || (ERA_MARKER_RE.test(str) && EDTF_CHARS_RE.test(str.replace(ERA_MARKERS_RE, "")));
}

/** The start of an EDTF date or interval (the part Zotero sorts by), or false if the string is not in the supported subset. */
export function parseEdtfBegin(input: string): DateParts | false {
	let str = normalizeDashes(input.trim());
	const circa = CIRCA_PREFIX_RE.test(str);
	if (circa) str = str.replace(CIRCA_PREFIX_RE, "");
	const era = eraToEdtf(str);
	if (era) str = era;
	if (!/^[-0-9]\S*$/.test(str)) return false;
	str = str.replace(/(^|\/)-([0-9]{1,3})(?=[-~?%/]|$)/g, (_m, pre: string, y: string) => `${pre}-${y.padStart(4, "0")}`);
	const range = str.match(/^([0-9]{4})-([0-9]{2}|[0-9]{4})$/);
	if (range) {
		const begin = parseInt(range[1]!, 10);
		let end = parseInt(range[2]!, 10);
		if (range[2]!.length === 2) end = end > 12 ? Math.floor(begin / 100) * 100 + end : 0;
		if (end > begin) str = `${range[1]}/${String(end).padStart(4, "0")}`;
	}
	if (circa && !/[~?%]$/.test(str)) str += "~";
	if (!EDTF_SHAPE_RE.test(str)) return false;

	const parse = (s: string): DateParts | false => {
		const m = s.match(/^(-?[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?([~?%])?$/);
		if (!m) return false;
		const d: DateParts = { year: parseInt(m[1]!, 10) };
		if (m[2]) {
			const month = parseInt(m[2], 10);
			if (month < 1 || month > 12) return false;
			d.month = month - 1;
			if (m[3]) {
				const day = parseInt(m[3], 10);
				if (day < 1 || day > daysInMonth(d.year as number, month)) return false;
				d.day = day;
			}
		}
		return d;
	};
	const [beginStr, endStr] = str.split("/");
	const begin = parse(beginStr!);
	if (!begin) return false;
	if (endStr !== undefined) {
		const end = parse(endStr);
		if (!end) return false;
		const key = (d: DateParts) => (d.year as number) * 10000 + (d.month !== undefined ? (d.month + 1) * 100 : 0) + (d.day || 0);
		if (key(end) <= key(begin)) return false;
	}
	return begin;
}

/** Zotero.Date.strToMultipart: "YYYY-MM-DD <original text>", 00 for missing parts, 0000 when there is no usable year. */
export function strToMultipart(str: string, now?: Date): string {
	if (!str) return "";
	const edtf = parseEdtfBegin(str);
	let parts: DateParts;
	if (edtf) parts = edtf;
	else if (hasEraNotation(normalizeDashes(str.trim()).replace(CIRCA_PREFIX_RE, ""))) parts = {};
	else parts = strToDate(str, now);
	let year = parts.year !== undefined && parts.year !== "" ? String(parts.year) : "";
	if (year && !/^[0-9]{1,4}$/.test(year)) year = ""; // no BCE / out-of-range years in the sort key
	const month = parts.month !== undefined ? parts.month + 1 : "";
	return `${year && year !== "0" ? lpad(year, 4) : "0000"}-${lpad(month, 2)}-${parts.day ? lpad(parts.day, 2) : "00"} ${str}`;
}
