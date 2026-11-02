// Layered memory breakdown: runs scripts/profile-stage.tsx once per stage (x runs) in a fresh process and prints medians.
//
//   bun scripts/profile-mem.ts [--window] [--stages bare,import,empty,fonts,hello,app] [--runs 3] [--wait 6] [--gc]
//                              [--env ZN_WINDOW=10,FOO=1] [--exe out-prof/zotero-next-gpui-plain.exe]
//   Build the exe with:  bun scripts/build.ts --entry scripts/profile-stage.tsx --out out-prof --variant plain
//   (source mode loads Babel via bunfig's preload and keeps ~70-150 MB of it; the exe numbers are the real ones)
//
// Each run is a separate process so the numbers do not contaminate each other. The sample at --wait seconds is reported.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const stages = opt("stages", "bare,import,empty,fonts,hello,app").split(",");
const runs = Number(opt("runs", "3"));
const extra = [...(flag("window") ? ["--window"] : []), ...(flag("gc") ? ["--gc"] : []), "--wait", opt("wait", "6")];
const envExtra = Object.fromEntries(opt("env", "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
const entry = opt("script", "scripts/profile-stage.tsx");
const exe = opt("exe", ""); // a scripts/build.ts compile of profile-stage.tsx: runs without Babel/bunfig preload (the shipped shape)
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

const rows: Record<string, unknown>[] = [];
for (const s of stages) {
	const samples: Record<string, number>[] = [];
	for (let i = 0; i < runs; i++) {
		const r = spawnSync(exe || "bun", [...(exe ? [] : [entry]), s, ...extra], { cwd: root, encoding: "utf8", env: { ...process.env, ZN_URL: process.env.ZN_URL ?? "http://127.0.0.1:23160", ...envExtra }, timeout: 60_000 });
		const last = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("SAMPLE ")).at(-1);
		if (!last) { console.error(`stage ${s} produced no sample`, r.stderr?.slice(0, 500)); continue; }
		samples.push(JSON.parse(last.slice(7)));
	}
	if (!samples.length) continue;
	const m = (k: string) => med(samples.map((x) => x[k] as number));
	const pr = samples.map((x) => x.privateMB as number);
	rows.push({ stage: s, privateMB: m("privateMB"), "priv min-max": `${Math.min(...pr)}-${Math.max(...pr)}`, wsMB: m("wsMB"), peakWsMB: m("peakWsMB"), jsHeapMB: m("jsHeapMB"), jsExtraMB: m("jsExtraMB"), objects: m("objects") });
}
console.table(rows);
