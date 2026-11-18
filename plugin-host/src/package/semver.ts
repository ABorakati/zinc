// Version comparison for plugin versions and Zinc's own. Semver 2.0 precedence (build metadata ignored); a version that does
// not parse compares by its numeric dotted parts, so "1.2" equals "1.2.0".

interface Parsed {
	nums: number[];
	pre: string[];
}

function parse(v: string): Parsed {
	const noBuild = v.trim().replace(/^v/i, "").split("+")[0];
	const dash = noBuild.indexOf("-");
	const core = dash < 0 ? noBuild : noBuild.slice(0, dash);
	const pre = dash < 0 ? [] : noBuild.slice(dash + 1).split(".");
	const nums = core.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
	while (nums.length < 3) nums.push(0);
	return { nums, pre };
}

/** -1, 0 or 1. */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
	const x = parse(a);
	const y = parse(b);
	const n = Math.max(x.nums.length, y.nums.length);
	for (let i = 0; i < n; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	if (!x.pre.length && !y.pre.length) return 0;
	if (!x.pre.length) return 1; // a release is above its pre-releases
	if (!y.pre.length) return -1;
	const m = Math.max(x.pre.length, y.pre.length);
	for (let i = 0; i < m; i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) {
			if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
		} else if (pn !== qn) return pn ? -1 : 1;
		else if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/**
 * Does a plugin built for `required` (MAJOR.MINOR) run on a Zinc that offers the API version `have` (MAJOR.MINOR[.PATCH])?
 * Same major and a minor at least as high; before 1.0 the minor must be equal (manifest.schema.json, zinc.api_version).
 */
export function apiCompatible(required: string, have: string): boolean {
	const [rMaj, rMin] = required.split(".").map(Number);
	const [hMaj, hMin] = have.split(".").map(Number);
	if (rMaj !== hMaj) return false;
	return rMaj === 0 ? rMin === hMin : hMin >= rMin;
}
