// Per-line (per citation / per bibliography entry) agreement between two engines in a parity report.
import { normalize } from "./normalize";
const [file, a = "citeproc-js", b = "hayagriva"] = process.argv.slice(2);
const r = await Bun.file(file!).json();
const arr = (x: any) => (Array.isArray(x) ? x : Object.values(x));
const ra = new Map(arr(r.results[a]).map((x: any) => [x.id, x])), rb = new Map(arr(r.results[b]).map((x: any) => [x.id, x]));
const by: Record<string, [number, number]> = {};
let same = 0, total = 0;
for (const [id, x] of ra as Map<string, any>) {
	const y = (rb as Map<string, any>).get(id);
	if (!x.ok || !y?.ok) continue;
	const la = String(x.output).split("\n"), lb = String(y.output).split("\n");
	const mode = id.endsWith("bibliography") ? "bibliography" : "citation";
	for (let i = 0; i < la.length; i++) {
		const eq = normalize(la[i]!) === normalize(lb[i] ?? "");
		total++; if (eq) same++;
		by[mode] ??= [0, 0]; by[mode][0] += eq ? 1 : 0; by[mode][1]++;
	}
}
console.log(`lines identical: ${same}/${total} (${((100 * same) / total).toFixed(1)}%)`);
for (const [k, [s, t]] of Object.entries(by)) console.log(`  ${k}: ${s}/${t} (${((100 * s) / t).toFixed(1)}%)`);
