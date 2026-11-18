// Runs bench/run.ts once per (section, plugin, variant) in a fresh process (several supervisors in one process hang
// the harness sooner or later) and prints the medians. Usage: bun bench/all.ts [--reps 3] [--plugins a,b] [--skip import,safety]
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { scratch, stats } from "./lib";

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const reps = Number(opt("--reps") ?? 3);
const plugins = (opt("--plugins") ?? "bench-guest,hello-rust,hello-js,quick-tags,ui-fixture").split(",");
const skip = new Set((opt("--skip") ?? "").split(","));
const variants = ["wt-jit", "wt-aot", "wt-aot-nobridge"];
const out = join(scratch, "all");

async function child(args: string[], file: string, timeoutMs: number): Promise<any> {
	const p = Bun.spawn(["bun", join(import.meta.dir, "run.ts"), ...args, "--out", file], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
	const timer = setTimeout(() => p.kill(), timeoutMs);
	const text = await new Response(p.stdout).text();
	await p.exited;
	clearTimeout(timer);
	if (!existsSync(file)) {
		console.log(`  (no result: ${args.join(" ")}) ${text.slice(-200)}`);
		return undefined;
	}
	return JSON.parse(readFileSync(file, "utf8"));
}

const fmt = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms.toFixed(1) + " ms");
const mb = (b: number) => (b / 1048576).toFixed(0) + " MB";
const rows: any[] = [];
if (!skip.has("cold")) {
	console.log("== cold start, median of reps (process start -> ready | load | startup | first call of each export | total) ==");
	for (const p of plugins)
		for (const v of variants) {
			const runs: any[] = [];
			for (let i = 0; i < reps; i++) {
				const r = await child(["--only", "cold", "--plugins", p, "--variants", v, "--reps", "1"], join(out + `-c-${p}-${v}-${i}.json`), 600_000);
				const x = r?.cold?.[`${p}/${v}`]?.[0];
				if (x && !x.error) runs.push(x);
				else if (x) console.log(`  ${p} ${v}: ${x.error}`);
			}
			if (!runs.length) continue;
			const med = (f: (x: any) => number) => stats(runs.map(f)).median;
			const firsts = runs[0].first.map((_: number, i: number) => fmt(stats(runs.map((x: any) => x.first[i])).median));
			console.log(`${p.padEnd(12)} ${v.padEnd(16)} up ${fmt(med((x) => x.up))} | load ${fmt(med((x) => x.load))} | startup ${fmt(med((x) => x.startup))} | first ${firsts.join(" / ")} | TOTAL ${fmt(med((x) => x.total))} | ws ${mb(med((x) => x.idleWs))} -> ${mb(med((x) => x.ws))} (+${mb(med((x) => x.ws - x.idleWs))}) [n=${runs.length}]`);
			rows.push({ p, v, up: med((x) => x.up), load: med((x) => x.load), startup: med((x) => x.startup), first: runs[0].first.map((_: number, i: number) => stats(runs.map((x: any) => x.first[i])).median), total: med((x) => x.total), idle: med((x) => x.idleWs), ws: med((x) => x.ws), detail: runs[0].loadDetail });
		}
}
if (!skip.has("steady")) {
	console.log("\n== steady state ==");
	for (const p of plugins)
		for (const v of variants.filter((x) => x !== "wt-jit")) {
			const r = await child(["--only", "steady", "--plugins", p, "--variants", v], join(out + `-s-${p}-${v}.json`), 900_000);
			const s = r?.steady?.[`${p}/${v}`];
			if (s) {
				console.log(`${p.padEnd(12)} ${v.padEnd(16)} median ${s.median.toFixed(0)} us  p95 ${s.p95.toFixed(0)} us  max ${s.max.toFixed(0)} us`);
				rows.push({ p, v, steady: s });
			}
		}
}
if (!skip.has("import")) {
	const r = await child(["--only", "import"], join(out + "-i.json"), 900_000);
	console.log("\n== import call cost ==");
	for (const [k, x] of Object.entries<any>(r?.imports ?? {})) console.log(`${k.padEnd(88)} n=${x.n} ${fmt(x.totalMs)}  ${x.perCallUs.toFixed(1)} us/call`);
	rows.push({ imports: r?.imports });
}
if (!skip.has("safety")) {
	const r = await child(["--only", "safety"], join(out + "-x.json"), 900_000);
	console.log("\n== safety ==");
	console.log(JSON.stringify(r?.safety, null, 1));
	rows.push({ safety: r?.safety });
}
await Bun.write(join(scratch, "all-result.json"), JSON.stringify(rows, null, 1));
process.exit(0);
