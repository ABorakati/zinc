// The packaged app the harness drives by default (run.ts): out/package-aot/zotero-next-gpui/zotero-next-gpui.exe, the build that ships.
// It is built again before a run when anything it is made from is newer than it, so a run never tests yesterday's app by accident.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The packaged app's executable (Windows: the only system where the harness keeps the app's windows off the screen). */
export const packagedApp = (gpui: string): string => join(gpui, "out", "package-aot", "zotero-next-gpui", "zotero-next-gpui.exe");

/** What the package is made from: the app's code and assets, the patches, the lock file, the renderer that ships, the build scripts. */
function sources(gpui: string): string[] {
	const out: string[] = [];
	for (const d of ["src", "patches", "assets"]) {
		const dir = join(gpui, d);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir, { recursive: true }) as string[]) out.push(join(dir, f));
	}
	for (const f of ["package.json", "bun.lock", "tsconfig.json", "scripts/package.ts", "scripts/build.ts"]) out.push(join(gpui, f));
	const addon = join(gpui, "node_modules", "@gpuix", "native-win32-x64-msvc");
	if (existsSync(addon)) for (const f of readdirSync(addon)) if (f.endsWith(".node")) out.push(join(addon, f));
	return out;
}

/** The newest source that is newer than the package, or undefined when the package is up to date. */
export function newerSource(gpui: string, exe: string): string | undefined {
	if (!existsSync(exe)) return exe;
	const built = statSync(exe).mtimeMs;
	for (const f of sources(gpui)) {
		try {
			const s = statSync(f);
			if (s.isFile() && s.mtimeMs > built) return f;
		} catch {
			/* gone between the listing and the stat */
		}
	}
	return undefined;
}

/**
 * The record of a whole UI run of a package that passed, next to the package (outside the folder that ships): out/package-aot/ui-pass.json.
 * scripts/release.ts reads it and will not publish a version that has none. `version` is the package's version.txt, which names the commit.
 */
export interface UiPass {
	version: string;
	exeSha256: string;
	at: string;
	passed: number;
	knownBugs: number;
	inProcess: number;
}
export const uiPassFile = (exe: string): string => join(dirname(dirname(exe)), "ui-pass.json");

export function recordPass(exe: string, counts: { passed: number; knownBugs: number; inProcess: number }): void {
	const versionFile = join(dirname(exe), "version.txt");
	if (!existsSync(versionFile)) return void console.warn(`no ${versionFile}: the run is not recorded for the release gate`);
	const pass: UiPass = {
		version: readFileSync(versionFile, "utf8").trim(),
		exeSha256: createHash("sha256").update(readFileSync(exe)).digest("hex"),
		at: new Date().toISOString(),
		...counts,
	};
	writeFileSync(uiPassFile(exe), `${JSON.stringify(pass, null, 2)}\n`);
	console.log(`recorded for the release gate: ${pass.version} (${uiPassFile(exe)})`);
}

/** Build the package (bun scripts/package.ts --aot) when it is missing or older than its sources; its output goes to `log`. */
export async function ensurePackage(gpui: string, log: string): Promise<{ exe: string; built: boolean; ms: number }> {
	const exe = packagedApp(gpui);
	const why = newerSource(gpui, exe);
	if (!why) return { exe, built: false, ms: 0 };
	const started = performance.now();
	rmSync(uiPassFile(exe), { force: true }); // a pass of the package being replaced says nothing of the new one
	console.log(existsSync(exe) ? `building the package: ${why} is newer than it` : "building the package: there is none yet");
	const p = Bun.spawn([process.execPath, "scripts/package.ts", "--aot"], { cwd: gpui, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	writeFileSync(log, `${o}\n${e}`);
	if (code !== 0 || !existsSync(exe)) throw new Error(`the package did not build (exit ${code}); its output is in ${log}`);
	return { exe, built: true, ms: performance.now() - started };
}
