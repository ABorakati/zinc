// Prepare the WASM plugin fixtures and precompiled `.cwasm` files under `%TEMP%\zn-p3-runner\b1\fixtures`
// (nothing is written outside `plugin-host-wasmtime/**` or `%TEMP%\zn-p3-runner\b1\**`):
//   - stages each fixture's source into `%TEMP%\zn-p3-runner\b1\src\<name>`
//   - builds Rust guests (`bench-guest`, `hello-rust`) with `cargo build --release --target wasm32-wasip2`
//   - builds QuickJS guests (`hello-js`, `ui-fixture`, `quick-tags`) directly with `componentize-qjs`
//   - runs `zhw precompile` on every `plugin.wasm` -> `plugin.cwasm`
// Usage: bun bench/prepare.ts [--force]
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { now, root, scratch, zhwBin } from "./lib";

export const fixturesDir = join(scratch, "fixtures");
const stagingRoot = join(scratch, "src");
const repoRoot = resolve(root, "..");
const apiWit = join(repoRoot, "plugin-api", "wit");
const qjsBin = join(
	repoRoot,
	"plugin-host",
	"node_modules",
	".bin",
	process.platform === "win32" ? "componentize-qjs.exe" : "componentize-qjs",
);

interface FixtureSource {
	name: string;
	srcDir: string;
	kind: "rust" | "js";
	world?: string;
}

const SOURCES: FixtureSource[] = [
	{ name: "bench-guest", srcDir: join(root, "bench", "guest"), kind: "rust" },
	{ name: "hello-rust", srcDir: join(repoRoot, "plugin-host", "test", "fixtures", "hello-rust"), kind: "rust" },
	{ name: "hello-js", srcDir: join(repoRoot, "plugin-host", "test", "fixtures", "hello-js"), kind: "js", world: "hello" },
	{
		name: "ui-fixture",
		srcDir: join(repoRoot, "gpui-ui", "src", "wasmplugins", "ui", "test", "fixture-ui-js"),
		kind: "js",
		world: "ui-fixture",
	},
	{ name: "quick-tags", srcDir: join(repoRoot, "plugin-api", "samples", "quick-tags"), kind: "js", world: "plugin" },
];

async function runCmd(cmd: string[], cwd: string, env?: Record<string, string>): Promise<string> {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err || out}`);
	return out;
}

async function checkDiskFloor() {
	if (process.platform !== "win32") return;
	const bash = "C:/Program Files/Git/bin/bash.exe";
	if (!existsSync(bash)) return;
	const out = await runCmd([bash, "-c", "df -m /c"], root);
	const lines = out.trim().split(/\r?\n/);
	const cols = lines[lines.length - 1]?.trim().split(/\s+/) ?? [];
	const availMb = Number(cols[3]);
	if (Number.isFinite(availMb) && availMb < 9216) {
		throw new Error(`Disk floor violated: only ${availMb} MiB available on /c (< 9216 MiB)`);
	}
}

async function ensureKacheWrapper(): Promise<Record<string, string>> {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const cargoBinDir = join(home, ".cargo", "bin");
	const rustupTcRoot = join(home, ".rustup", "toolchains");
	let rustupStableBin: string | undefined;
	if (existsSync(rustupTcRoot)) {
		const dirs = await readdir(rustupTcRoot);
		rustupStableBin = dirs
			.filter((d) => d.startsWith("stable-"))
			.map((d) => join(rustupTcRoot, d, "bin"))
			.find((p) => existsSync(p));
	}
	const extraBins = [cargoBinDir, rustupStableBin].filter((p): p is string => !!p && existsSync(p));
	const sep = process.platform === "win32" ? ";" : ":";
	const base: Record<string, string> = extraBins.length
		? { PATH: `${extraBins.join(sep)}${sep}${process.env.PATH ?? ""}` }
		: {};
	if (process.platform !== "win32") return base;
	const kacheSrc = join(cargoBinDir, "kache.exe");
	const kacheDst = join(scratch, "kache-rustc.exe");
	if (existsSync(kacheSrc) && !existsSync(kacheDst)) {
		await mkdir(scratch, { recursive: true });
		await cp(kacheSrc, kacheDst);
	}
	return existsSync(kacheDst) ? { ...base, RUSTC_WRAPPER: kacheDst } : base;
}

async function stageSource(src: string, staged: string) {
	await mkdir(staged, { recursive: true });
	for (const item of ["Cargo.toml", "Cargo.lock", "manifest.json", "plugin.js", "src", "wit", "locale", "icons", "assets"]) {
		const p = join(src, item);
		if (existsSync(p)) {
			await cp(p, join(staged, item), { recursive: true, force: true });
		}
	}
	if (existsSync(join(staged, "wit"))) {
		const depsDir = join(staged, "wit", "deps", "zinc-plugin");
		await mkdir(depsDir, { recursive: true });
		for (const f of (await readdir(apiWit)).filter((n) => n.endsWith(".wit"))) {
			await cp(join(apiWit, f), join(depsDir, f), { force: true });
		}
	}
}

export async function prepareAll(opts: { force?: boolean; quiet?: boolean } = {}) {
	await mkdir(fixturesDir, { recursive: true });
	await mkdir(stagingRoot, { recursive: true });
	const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
	const report: Record<string, any> = {};
	const rustEnv = await ensureKacheWrapper();

	for (const fx of SOURCES) {
		if (!existsSync(join(fx.srcDir, "manifest.json"))) {
			log(`skipping ${fx.name}: not found at ${fx.srcDir}`);
			continue;
		}
		const dst = join(fixturesDir, fx.name);
		const wasmPath = join(dst, "plugin.wasm");
		const cwasmPath = join(dst, "plugin.cwasm");

		if (opts.force || !existsSync(wasmPath)) {
			const t0 = now();
			const staged = join(stagingRoot, fx.name);
			await stageSource(fx.srcDir, staged);
			await mkdir(dst, { recursive: true });

			let wasmBytes: Uint8Array;
			if (fx.kind === "rust") {
				await checkDiskFloor();
				log(`building Rust fixture ${fx.name}...`);
				const cargoCmd = Bun.which("cargo", { PATH: rustEnv.PATH ?? process.env.PATH }) ?? "cargo";
				await runCmd([cargoCmd, "build", "--release", "--target", "wasm32-wasip2"], staged, rustEnv);
				const meta = JSON.parse(await runCmd([cargoCmd, "metadata", "--format-version", "1", "--no-deps"], staged, rustEnv));
				const pkg = meta.packages[0];
				const lib = pkg.targets.find((t: { crate_types: string[] }) => t.crate_types.includes("cdylib")) ?? pkg.targets[0];
				const builtWasm = join(meta.target_directory, "wasm32-wasip2", "release", `${String(lib.name).replace(/-/g, "_")}.wasm`);
				wasmBytes = new Uint8Array(await Bun.file(builtWasm).arrayBuffer());
			} else {
				log(`building QuickJS fixture ${fx.name}...`);
				const manifest = await Bun.file(join(staged, "manifest.json")).json();
				const origEntry = [
					join(fx.srcDir, "plugin.js"),
					join(fx.srcDir, "src", "main.js"),
					join(fx.srcDir, "src", "main.ts"),
					join(fx.srcDir, "src", "index.js"),
					join(fx.srcDir, "src", "index.ts"),
				].find((f) => existsSync(f));
				if (!origEntry) throw new Error(`no JS entry in ${fx.srcDir}`);
				let entry = join(staged, "plugin.js");
				if (!existsSync(entry)) {
					const b = await Bun.build({
						entrypoints: [origEntry],
						outdir: staged,
						naming: "bundled.js",
						format: "esm",
						target: "browser",
						external: ["zinc:*"],
						minify: false,
					});
					if (!b.success) {
						log(`  skipping optional JS sample ${fx.name}: ${b.logs.map(String).join("; ")}`);
						continue;
					}
					entry = join(staged, "bundled.js");
					const code = await Bun.file(entry).text();
					if (code.includes("__zincOpenDialog")) {
						await Bun.write(entry, `import __sdk_zui from "zinc:plugin/ui@0.1.0";\nglobalThis.__zincOpenDialog = __sdk_zui.openDialog;\n${code}`);
					}
				}
				const witDir = existsSync(join(staged, "wit")) ? join(staged, "wit") : apiWit;
				const world = fx.world ?? manifest.main?.world ?? "plugin";
				const outWasm = join(staged, "built.wasm");
				await runCmd([qjsBin, "--wit", witDir, "--js", entry, "--world", world, "--sync", "--opt-size", "--stub-wasi", "-o", outWasm], staged);
				wasmBytes = new Uint8Array(await Bun.file(outWasm).arrayBuffer());
			}

			await Bun.write(wasmPath, wasmBytes);
			const manifest = await Bun.file(join(staged, "manifest.json")).json();
			const sha256 = new Bun.CryptoHasher("sha256").update(wasmBytes).digest("hex");
			manifest.main = { ...manifest.main, wasm: "plugin.wasm", language: fx.kind, sha256 };
			await Bun.write(join(dst, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
			for (const extra of ["locale", "icons", "assets"]) {
				if (existsSync(join(staged, extra))) {
					await cp(join(staged, extra), join(dst, extra), { recursive: true, force: true });
				}
			}
			report[fx.name] = { buildMs: now() - t0 };
		}

		if (opts.force || !existsSync(cwasmPath)) {
			const runs: any[] = [];
			const reps = opts.quiet ? 1 : 3;
			for (let i = 0; i < reps; i++) {
				const text = await runCmd([zhwBin, "precompile", wasmPath, cwasmPath], root);
				runs.push(JSON.parse(text));
			}
			const ms = runs.map((r) => r.precompileMs as number).sort((a, b) => a - b);
			report[fx.name] = {
				...(report[fx.name] ?? {}),
				wasmBytes: runs[0].wasmBytes,
				cwasmBytes: runs[0].cwasmBytes,
				precompileMs: { min: ms[0], median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] },
			};
			log(
				`  ${fx.name.padEnd(16)} wasm ${(runs[0].wasmBytes / 1e6).toFixed(2)} MB  cwasm ${(runs[0].cwasmBytes / 1e6).toFixed(2)} MB  precompile ${ms[Math.floor(ms.length / 2)].toFixed(0)} ms`,
			);
		} else {
			const ws = (await stat(wasmPath)).size;
			const cs = (await stat(cwasmPath)).size;
			report[fx.name] = { ...(report[fx.name] ?? {}), wasmBytes: ws, cwasmBytes: cs };
		}
	}

	await Bun.write(join(scratch, "prepare.json"), JSON.stringify(report, null, 2));
	return report;
}

if (import.meta.main) {
	await prepareAll({ force: process.argv.includes("--force") });
}
