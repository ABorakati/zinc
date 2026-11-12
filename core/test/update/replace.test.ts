// Linux and macOS self-update: the per-platform feed (platform.ts), the AppImage swap and the Zinc.app swap (replace.ts), driven through
// the real updater + the real env.ts file side, with the network faked (no feed server) and the process starts recorded. Real files in a
// temporary folder, so the rename / chmod / unpack steps are the real ones. On Linux (and macOS) the two shell programs themselves run too:
// the AppImage relaunch waiter and the macOS swap helper, with stand-ins for `open`.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRealEnv } from "../../src/update/env";
import { installerName, planCleanup } from "../../src/update/machine";
import { generateKeyPair, signManifest, validateShape, type KeyPair, type Manifest } from "../../src/update/manifest";
import { currentPlatform, feedFileName, feedUrlFor, manifestPlatform } from "../../src/update/platform";
import { WAIT_THEN_EXEC, appImageReplace, detectSelfReplace, macAppReplace, macSwapScript, relaunchEnv, type ReplaceDeps, type SelfReplace } from "../../src/update/replace";
import { createUpdater, type UpdateEnv } from "../../src/update/updater";

const ROOT = mkdtempSync(join(tmpdir(), "zn-replace-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const posix = process.platform !== "win32";
const CURRENT = "0.1.0+b7cd9fc4-20261106";
const NEXT = "0.2.0+1a2b3c4d-20261201";
const NEW_BYTES = new TextEncoder().encode("#!/bin/sh\necho new zinc\n" + "x".repeat(3000));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let kp: KeyPair;
beforeEach(async () => { kp = await generateKeyPair(); });

let n = 0;
const fresh = (name: string) => { const d = join(ROOT, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

async function signed(platform: string | undefined, o: { bytes?: Uint8Array; url?: string } = {}): Promise<Manifest> {
	const bytes = o.bytes ?? NEW_BYTES;
	return signManifest({
		version: NEXT, releasedAt: "2026-12-01T09:00:00Z", notes: "# 0.2.0", url: o.url ?? "https://example.org/Zinc-0.2.0-x86_64.AppImage",
		sha256: sha(bytes), size: bytes.length, ...(platform ? { platform } : {}),
	}, kp.privateJwk);
}

/** The real env.ts (files), with the network replaced: the manifest text and the download bytes come from here. */
function env(o: { updatesDir: string; replace?: SelfReplace; manifest: () => Manifest | string; bytes?: Uint8Array }) {
	const fetched: string[] = [];
	const exits: number[] = [];
	const real = createRealEnv({ updatesDir: o.updatesDir, replace: o.replace, exit: (c) => void exits.push(c) });
	const e: UpdateEnv = {
		...real,
		async fetchText(url) { fetched.push(url); const m = o.manifest(); return typeof m === "string" ? m : JSON.stringify(m); },
		async download(_url, dest, { onProgress }) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, o.bytes ?? NEW_BYTES); onProgress((o.bytes ?? NEW_BYTES).length, (o.bytes ?? NEW_BYTES).length); },
		runInstaller() { throw new Error("no installer on Linux / macOS"); },
	};
	return { env: e, fetched, exits };
}

function recorder() {
	const spawned: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
	const spawn: NonNullable<ReplaceDeps["spawn"]> = (cmd, args, o) => void spawned.push({ cmd, args, env: o?.env });
	return { spawned, spawn };
}

describe("per-platform feed (pure)", () => {
	test("platforms and manifest file names", () => {
		expect(currentPlatform("win32", "x64")).toBe("win-x64");
		expect(currentPlatform("linux", "x64")).toBe("linux-x64");
		expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
		expect(currentPlatform("linux", "arm64")).toBeNull();
		expect(feedFileName("win-x64")).toBe("latest.json");
		expect(feedFileName("linux-x64")).toBe("latest-linux-x64.json");
	});
	test("feedUrlFor: Windows keeps latest.json, the others read latest-<platform>.json next to it", () => {
		const gh = "https://github.com/o/zotero-next-releases/releases/latest/download/latest.json";
		expect(feedUrlFor(gh, "win-x64")).toBe(gh);
		expect(feedUrlFor(gh, "linux-x64")).toBe("https://github.com/o/zotero-next-releases/releases/latest/download/latest-linux-x64.json");
		expect(feedUrlFor("https://e.org/feed/latest.json?x=1", "darwin-arm64")).toBe("https://e.org/feed/latest-darwin-arm64.json?x=1");
		expect(feedUrlFor("https://e.org/latest-linux-x64.json", "linux-x64")).toBe("https://e.org/latest-linux-x64.json"); // set by hand
		expect(feedUrlFor("https://api.github.com/repos/o/r/releases/assets/123", "linux-x64")).toBe("https://api.github.com/repos/o/r/releases/assets/123");
		expect(feedUrlFor("not a url", "linux-x64")).toBe("not a url");
	});
	test("platform field: optional, signed, validated; absent = win-x64", async () => {
		const win = await signed(undefined);
		expect("platform" in win).toBe(false); // latest.json stays readable by older Windows builds
		expect(manifestPlatform(win)).toBe("win-x64");
		const lin = await signed("linux-x64");
		expect(lin.platform).toBe("linux-x64");
		expect(() => validateShape({ ...lin, platform: "Linux x64" })).toThrow(/platform/);
	});
	test("download names and cleanup cover every platform's files, nothing else", () => {
		const m = { version: NEXT, url: "https://e.org/a" };
		expect(installerName(m, "linux-x64")).toBe(`.zinc-update-${NEXT}.AppImage.download`);
		expect(installerName(m, "darwin-arm64")).toBe(`zinc-update-${NEXT}.app.zip`);
		expect(installerName(m)).toBe(`zotero-next-${NEXT}-setup.exe`);
		const files = [".zinc-update-0.0.9.AppImage.download", `.zinc-update-${NEXT}.AppImage.download.part`, "zinc-update-0.0.9.app.zip", "Zinc-0.1.0-x86_64.AppImage", "notes.AppImage", ".zinc-update"];
		expect(planCleanup(files, []).sort()).toEqual([".zinc-update-0.0.9.AppImage.download", `.zinc-update-${NEXT}.AppImage.download.part`, "zinc-update-0.0.9.app.zip"].sort());
		// start-up: a newer partial download survives so it can be resumed
		expect(planCleanup(files, [], CURRENT).sort()).toEqual([".zinc-update-0.0.9.AppImage.download", "zinc-update-0.0.9.app.zip"]);
	});
});

describe("Linux: the AppImage swap", () => {
	function setup(o: { canWrite?: boolean; manifest?: () => Manifest | string; env?: Record<string, string | undefined> } = {}) {
		const dir = fresh("appimage");
		const appimage = join(dir, "Zinc-0.1.0-x86_64.AppImage");
		writeFileSync(appimage, "old zinc");
		const r = recorder();
		const replace = appImageReplace({ appimage, spawn: r.spawn, env: o.env ?? { PATH: "/usr/bin" }, ...(o.canWrite === false ? { canWrite: async () => false } : {}) });
		return { dir, appimage, replace, ...r, o };
	}
	test("check reads latest-linux-x64.json, downloads next to the AppImage, Install now renames it over $APPIMAGE and relaunches after exit", async () => {
		const s = setup();
		const m = await signed("linux-x64");
		const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => m });
		const order: string[] = [];
		const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: false, feedUrl: "https://example.org/dl/latest.json" }), prepareExit: async () => { order.push("prepareExit"); } });
		await u.check({ manual: true });
		expect(e.fetched).toEqual(["https://example.org/dl/latest-linux-x64.json"]);
		expect(u.model().state).toMatchObject({ kind: "available" });
		expect((u.model().state as { manualOnly?: boolean }).manualOnly).toBeUndefined();
		await u.download();
		const file = join(s.dir, `.zinc-update-${NEXT}.AppImage.download`).replaceAll("\\", "/");
		expect(u.model().state).toMatchObject({ kind: "ready", file });
		expect(readFileSync(s.appimage, "utf8")).toBe("old zinc"); // nothing replaced before Install now
		await u.installNow();
		expect(order).toEqual(["prepareExit"]);
		expect(readFileSync(s.appimage)).toEqual(Buffer.from(NEW_BYTES));
		expect(existsSync(file)).toBe(false);
		if (posix) expect(statSync(s.appimage).mode & 0o111).toBe(0o111);
		expect(s.spawned).toEqual([{ cmd: "/bin/sh", args: ["-c", WAIT_THEN_EXEC, "zinc-relaunch", String(process.pid), s.appimage], env: { PATH: "/usr/bin" } }]);
		expect(e.exits).toEqual([0]);
	});
	test("install on exit: verified + prepared before exit, renamed in the exit handler, no relaunch", async () => {
		const s = setup();
		const m = await signed("linux-x64");
		const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => m });
		const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: false, feedUrl: "https://example.org/latest.json" }) });
		await u.check();
		await u.setInstallOnExit(true);
		expect(u.model()).toMatchObject({ installOnExit: true, state: { kind: "ready" } });
		await u.prepareForExit();
		u.onExit(0);
		u.onExit(0);
		expect(readFileSync(s.appimage)).toEqual(Buffer.from(NEW_BYTES));
		expect(s.spawned).toEqual([]);
	});
	test("a crash exit or a tampered download replaces nothing", async () => {
		const m = await signed("linux-x64");
		{
			const s = setup();
			const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => m });
			const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: true, feedUrl: "https://e.org/latest.json" }) });
			await u.check(); await u.setInstallOnExit(true); await u.prepareForExit(); u.onExit(3);
			expect(readFileSync(s.appimage, "utf8")).toBe("old zinc");
		}
		{
			const s = setup();
			const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => m });
			const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: true, feedUrl: "https://e.org/latest.json" }) });
			await u.check(); await u.setInstallOnExit(true);
			const st = u.model().state as { file: string };
			writeFileSync(st.file, "evil");
			await u.prepareForExit(); u.onExit(0);
			expect(readFileSync(s.appimage, "utf8")).toBe("old zinc");
			await u.installNow();
			expect(readFileSync(s.appimage, "utf8")).toBe("old zinc");
			expect(u.model().state).toMatchObject({ kind: "error", phase: "install" });
			expect(e.exits).toEqual([]);
		}
	});
	test("a folder it cannot write: the update is offered by hand, with the reason, and nothing is downloaded", async () => {
		const s = setup({ canWrite: false });
		const m = await signed("linux-x64");
		const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => m });
		const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: true, feedUrl: "https://e.org/latest.json" }) });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "available", manualOnly: true });
		expect((u.model().state as { manualReason?: string }).manualReason).toContain("cannot write");
		await u.installNow();
		expect(readFileSync(s.appimage, "utf8")).toBe("old zinc");
		expect(e.exits).toEqual([]);
	});
	test("not an AppImage: manual, with the reason; Windows gets no replacer", async () => {
		const linux = detectSelfReplace({ updatesDir: "/u", platform: "linux", arch: "x64", env: {} })!;
		expect(linux.platform).toBe("linux-x64");
		expect(await linux.manualReason()).toContain("not running from an AppImage");
		expect(detectSelfReplace({ updatesDir: "/u", platform: "linux", arch: "x64", env: { APPIMAGE: "/home/a/Apps/Zinc.AppImage" } })!.downloadDir).toBe("/home/a/Apps");
		expect(detectSelfReplace({ updatesDir: "/u", platform: "win32", arch: "x64", env: {} })).toBeUndefined();
		const mac = detectSelfReplace({ updatesDir: "/u", platform: "darwin", arch: "arm64", env: {}, execPath: "/Applications/Zinc.app/Contents/MacOS/zotero-next-gpui" })!;
		expect(mac.platform).toBe("darwin-arm64");
		expect(await detectSelfReplace({ updatesDir: "/u", platform: "darwin", arch: "arm64", env: {}, execPath: "/usr/local/bin/bun" })!.manualReason()).toContain("not running from Zinc.app");
	});
	test("a manifest for another platform is refused (the Windows latest.json served to Linux)", async () => {
		const s = setup();
		const win = await signed(undefined);
		const e = env({ updatesDir: fresh("updates"), replace: s.replace, manifest: () => win });
		const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: true, feedUrl: "https://e.org/latest-linux-x64.json" }) });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "error", phase: "check", code: "wrong-platform" });
	});
	test("relaunch environment drops the old AppImage's variables and library folders", () => {
		expect(relaunchEnv({ APPIMAGE: "/a/Z.AppImage", APPDIR: "/tmp/.mount_Zx", ARGV0: "z", OWD: "/home", HOME: "/home/a", LD_LIBRARY_PATH: "/opt/lib:/usr/lib:/tmp/.mount_Zx/usr/lib/zinc/lib" }))
			.toEqual({ HOME: "/home/a", LD_LIBRARY_PATH: "/opt/lib:/usr/lib" });
		expect(relaunchEnv({ APPDIR: "/tmp/.mount_Zx", LD_LIBRARY_PATH: "/tmp/.mount_Zx/usr/lib/zinc/lib" })).toEqual({});
	});
});

describe("macOS: the Zinc.app swap", () => {
	/** A fake ditto (unpacks a fixed Zinc.app), codesign (exit codes from `sign`) and xattr, recording the calls. */
	function setup(o: { verify?: number[]; canWrite?: boolean; translocated?: boolean; badArchive?: boolean } = {}) {
		const dir = fresh("mac");
		const apps = join(dir, o.translocated ? "AppTranslocation" : "Applications");
		const app = join(apps, "Zinc.app");
		mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
		writeFileSync(join(app, "Contents", "MacOS", "zotero-next-gpui"), "old");
		const updatesDir = join(dir, "updates");
		const calls: string[] = [];
		const verify = [...(o.verify ?? [0])];
		const exec: NonNullable<ReplaceDeps["exec"]> = async (cmd, args) => {
			calls.push([cmd.split("/").pop(), ...args.map((a) => a.replaceAll("\\", "/").replace(dir.replaceAll("\\", "/"), "<dir>"))].join(" "));
			if (cmd.endsWith("ditto")) {
				const into = join(args[3]!, "Zinc.app", "Contents", "MacOS");
				mkdirSync(into, { recursive: true });
				if (!o.badArchive) writeFileSync(join(into, "zotero-next-gpui"), "new");
				writeFileSync(join(into, "libzn_pdf.dylib"), "lib");
				return 0;
			}
			if (cmd.endsWith("codesign") && args[0] === "--verify") return verify.shift() ?? 0;
			return 0;
		};
		const r = recorder();
		const replace = macAppReplace({ app: o.translocated ? `/private/var/folders/x/AppTranslocation/1/Zinc.app` : app, updatesDir, exec, spawn: r.spawn, ...(o.canWrite === false ? { canWrite: async () => false } : {}) });
		return { dir, app, updatesDir, replace, calls, ...r };
	}
	const m = () => signed("darwin-arm64", { url: "https://example.org/Zinc-0.2.0-arm64.app.zip" });

	test("download to the updates folder, unpack next to the bundle, check the signature, then the helper does the swap after exit", async () => {
		const s = setup();
		const mf = await m();
		const e = env({ updatesDir: s.updatesDir, replace: s.replace, manifest: () => mf });
		const u = createUpdater({ currentVersion: CURRENT, publicKey: kp.publicKey, env: e.env, settings: () => ({ enabled: true, autoDownload: true, feedUrl: "https://example.org/latest.json" }) });
		await u.check();
		expect(e.fetched).toEqual(["https://example.org/latest-darwin-arm64.json"]);
		const file = `${s.updatesDir.replaceAll("\\", "/")}/zinc-update-${NEXT}.app.zip`;
		expect(u.model().state).toMatchObject({ kind: "ready", file });
		await u.installNow();
		const stage = join(s.dir, "Applications", ".zinc-update");
		expect(s.calls).toEqual([
			`ditto -x -k ${file.replace(s.dir.replaceAll("\\", "/"), "<dir>")} <dir>/Applications/.zinc-update`,
			"xattr -dr com.apple.quarantine <dir>/Applications/.zinc-update/Zinc.app",
			"codesign --verify --deep --strict <dir>/Applications/.zinc-update/Zinc.app",
		]);
		const script = join(stage, "apply.sh");
		expect(s.spawned).toEqual([{ cmd: "/bin/sh", args: [script, String(process.pid), "1"], env: undefined }]);
		const text = readFileSync(script, "utf8");
		expect(text).toContain(`APP='${s.app}'`);
		expect(text).toContain(`NEW='${join(stage, "Zinc.app")}'`);
		expect(readFileSync(join(stage, "prepared.sha256"), "utf8").trim()).toBe(mf.sha256);
		expect(readFileSync(join(s.app, "Contents", "MacOS", "zotero-next-gpui"), "utf8")).toBe("old"); // the app swaps itself only after exit
		expect(e.exits).toEqual([0]);
	});
	test("a signature that does not verify is re-signed ad hoc (libraries first), then must verify", async () => {
		const s = setup({ verify: [1, 0] });
		const mf = await m();
		await s.replace.prepare(join(s.dir, "z.zip"), mf);
		expect(s.calls.slice(2)).toEqual([
			"codesign --verify --deep --strict <dir>/Applications/.zinc-update/Zinc.app",
			"codesign --force --sign - <dir>/Applications/.zinc-update/Zinc.app/Contents/MacOS/libzn_pdf.dylib",
			"codesign --force --sign - <dir>/Applications/.zinc-update/Zinc.app",
			"codesign --verify --deep --strict <dir>/Applications/.zinc-update/Zinc.app",
		]);
		const bad = setup({ verify: [1, 1] });
		await expect(bad.replace.prepare(join(bad.dir, "z.zip"), mf)).rejects.toThrow(/signature/);
		expect(() => bad.replace.apply("", { relaunch: false, pid: 1 })).toThrow(/not prepared/);
	});
	test("prepare runs once per download; an archive without the app is refused", async () => {
		const s = setup();
		const mf = await m();
		await s.replace.prepare("z.zip", mf);
		await s.replace.prepare("z.zip", mf);
		expect(s.calls.filter((c) => c.startsWith("ditto")).length).toBe(1);
		await expect(setup({ badArchive: true }).replace.prepare("z.zip", mf)).rejects.toThrow(/zotero-next-gpui/);
		await s.replace.cleanupStale!();
		expect(existsSync(join(s.dir, "Applications", ".zinc-update"))).toBe(false);
	});
	test("a folder it cannot write, or a translocated copy: manual, with the reason", async () => {
		expect(await setup({ canWrite: false }).replace.manualReason()).toContain("cannot write");
		expect(await setup({ translocated: true }).replace.manualReason()).toContain("temporary read-only copy");
		expect(await setup().replace.manualReason()).toBeNull();
	});
	test("the helper script quotes paths for sh", () => {
		const t = macSwapScript({ app: "/Users/o'neil/Apps/Zinc.app", fresh: "/x/new.app", stage: "/x", log: "/l/apply.log" });
		expect(t).toContain(`APP='/Users/o'\\''neil/Apps/Zinc.app'`);
		expect(t.startsWith("#!/bin/sh\n")).toBe(true);
	});
});

// The shell programs themselves. Needs a POSIX sh (Linux, macOS); WSL runs these for the Windows checkout.
describe.skipIf(!posix)("shell helpers (real sh)", () => {
	const waitGone = async (path: string, ms = 8000) => { const t0 = Date.now(); while (!existsSync(path)) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${path}`); await Bun.sleep(50); } };
	/** A process that lives ~`s` seconds: the stand-in for the quitting app. */
	const sleeper = (s: number) => nodeSpawn("sleep", [String(s)], { stdio: "ignore" });

	test("AppImage relaunch waiter: starts the new file only after the old pid is gone", async () => {
		const dir = fresh("relaunch");
		const appimage = join(dir, "Zinc.AppImage");
		const marker = join(dir, "started");
		writeFileSync(appimage, `#!/bin/sh\necho started > '${marker}'\n`, { mode: 0o755 });
		const old = sleeper(0.6);
		const t0 = Date.now();
		nodeSpawn("/bin/sh", ["-c", WAIT_THEN_EXEC, "zinc-relaunch", String(old.pid), appimage], { detached: true, stdio: "ignore" }).unref();
		await Bun.sleep(250);
		expect(existsSync(marker)).toBe(false); // still waiting for the old process
		await waitGone(marker);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
	});

	function macFixture() {
		const dir = fresh("macsh");
		const app = join(dir, "Applications", "Zinc.app");
		const stage = join(dir, "Applications", ".zinc-update");
		const neu = join(stage, "Zinc.app");
		mkdirSync(join(app, "Contents"), { recursive: true });
		mkdirSync(join(neu, "Contents"), { recursive: true });
		writeFileSync(join(app, "Contents", "v"), "old");
		writeFileSync(join(neu, "Contents", "v"), "new");
		const opened = join(dir, "opened");
		const open = join(dir, "open");
		writeFileSync(open, `#!/bin/sh\necho "$1" >> '${opened}'\n`, { mode: 0o755 });
		const script = join(stage, "apply.sh");
		writeFileSync(script, macSwapScript({ app, fresh: neu, stage, log: join(dir, "apply.log"), open }), { mode: 0o755 });
		return { dir, app, stage, neu, opened, script };
	}
	/** The pid of a process that has already ended. */
	const deadPid = () => new Promise<number>((res) => { const c = nodeSpawn("true", [], { stdio: "ignore" }); c.on("exit", () => res(c.pid!)); });
	const run = (script: string, pid: number, relaunch: boolean) => new Promise<number>((res) => nodeSpawn("/bin/sh", [script, String(pid), relaunch ? "1" : "0"], { stdio: "ignore" }).on("exit", (c) => res(c ?? 1)));

	test("macOS helper: waits for the pid, swaps the bundle, removes the stage, relaunches", async () => {
		const f = macFixture();
		const old = sleeper(0.5);
		const code = await run(f.script, old.pid!, true);
		expect(code).toBe(0);
		expect(readFileSync(join(f.app, "Contents", "v"), "utf8")).toBe("new");
		expect(existsSync(f.stage)).toBe(false);
		expect(readFileSync(f.opened, "utf8").trim()).toBe(f.app);
		expect(readFileSync(join(f.dir, "apply.log"), "utf8")).toContain("replaced");
	});
	test("macOS helper: no relaunch for install on exit; a missing new bundle leaves the old one (and relaunches it if asked)", async () => {
		const a = macFixture();
		expect(await run(a.script, await deadPid(), false)).toBe(0);
		expect(existsSync(a.opened)).toBe(false);
		const b = macFixture();
		rmSync(b.neu, { recursive: true });
		expect(await run(b.script, await deadPid(), true)).toBe(1);
		expect(readFileSync(join(b.app, "Contents", "v"), "utf8")).toBe("old");
		expect(readFileSync(b.opened, "utf8").trim()).toBe(b.app);
	});
});
