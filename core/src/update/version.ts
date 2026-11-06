// Version numbers of the app: "0.1.0+b7cd9fc4-20261106" = release 0.1.0, built from commit b7cd9fc4 on 2026-11-06 (gpui-ui/scripts/build.ts).
//
// Order: the numeric release part first (1.10.0 > 1.9.0; missing parts count as 0), then a pre-release tag ("0.2.0-beta.1" < "0.2.0",
// as in semver), then the build date (yyyymmdd; a version without a date counts as 0). The commit id is NOT ordered: two builds of the
// same release on the same day are equal. Pure: no I/O.

export interface ParsedVersion {
	/** The text that was parsed. */
	raw: string;
	release: number[];
	/** Pre-release identifiers ("beta", 1), empty for a final release. */
	pre: (string | number)[];
	commit?: string;
	/** yyyymmdd as a number, 0 when the version has no date suffix. */
	date: number;
}

const RE = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9a-fA-F]+)(?:-(\d{8}))?)?$/;

/** Parse a version string, or null if it is not one ("dev", "", "1.x"). */
export function parseVersion(s: string): ParsedVersion | null {
	if (typeof s !== "string") return null;
	const m = RE.exec(s.trim());
	if (!m) return null;
	return {
		raw: s.trim(),
		release: m[1]!.split(".").map(Number),
		pre: m[2] ? m[2].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
		commit: m[3]?.toLowerCase(),
		date: m[4] ? Number(m[4]) : 0,
	};
}

const cmpNum = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

function comparePre(a: (string | number)[], b: (string | number)[]): number {
	if (!a.length && !b.length) return 0;
	if (!a.length) return 1; // a final release is newer than its pre-releases
	if (!b.length) return -1;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i], y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return cmpNum(x, y);
		if (typeof x === "number") return -1; // numeric identifiers sort before text ones
		if (typeof y === "number") return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** -1 / 0 / 1 for a < b / equal / a > b. Throws for a string that is not a version. */
export function compareVersions(a: string | ParsedVersion, b: string | ParsedVersion): number {
	const pa = typeof a === "string" ? parseVersion(a) : a;
	const pb = typeof b === "string" ? parseVersion(b) : b;
	if (!pa) throw new Error(`not a version: ${String(a)}`);
	if (!pb) throw new Error(`not a version: ${String(b)}`);
	for (let i = 0; i < Math.max(pa.release.length, pb.release.length); i++) {
		const c = cmpNum(pa.release[i] ?? 0, pb.release[i] ?? 0);
		if (c) return c;
	}
	return comparePre(pa.pre, pb.pre) || cmpNum(pa.date, pb.date);
}

/** True if `candidate` is strictly newer than `current`. False when either is not a version (a dev build is never updated). */
export function isNewer(candidate: string, current: string): boolean {
	const a = parseVersion(candidate), b = parseVersion(current);
	return !!a && !!b && compareVersions(a, b) > 0;
}

/** "0.1.0+b7cd9fc4-20261106" -> "0.1.0 (2026-11-06)" for the UI; unparseable text is returned as is. */
export function displayVersion(s: string): string {
	const p = parseVersion(s);
	if (!p) return s;
	const d = p.date ? `${String(p.date).slice(0, 4)}-${String(p.date).slice(4, 6)}-${String(p.date).slice(6, 8)}` : "";
	const rel = p.release.join(".") + (p.pre.length ? `-${p.pre.join(".")}` : "");
	return d ? `${rel} (${d})` : rel;
}
