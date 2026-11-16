import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { initialModel, installerName, planCleanup, reduce, type UpdateModel } from "../../src/update/machine";
import { UpdateError, generateKeyPair, signManifest, type KeyPair, type Manifest } from "../../src/update/manifest";
import { createUpdater, installerArgs, type UpdateEnv, type UpdateSettings } from "../../src/update/updater";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const INSTALLER = new Uint8Array(5000).map((_, i) => (i * 7 + 3) % 251);
const DIR = "C:/fake/updates";

let kp: KeyPair;
beforeEach(async () => {
	kp = await generateKeyPair();
});

async function signed(
	version: string,
	o: Partial<{ bytes: Uint8Array; minVersion: string; sha256: string; size: number; url: string }> = {},
): Promise<Manifest> {
	const bytes = o.bytes ?? INSTALLER;
	return signManifest(
		{
			version,
			releasedAt: "2026-12-01T09:00:00Z",
			notes: "# notes\n- a thing",
			url: o.url ?? "https://example.org/zotero-next-setup.exe",
			sha256: o.sha256 ?? sha(bytes),
			size: o.size ?? bytes.length,
			...(o.minVersion ? { minVersion: o.minVersion } : {}),
		},
		kp.privateJwk,
	);
}

/** In-memory UpdateEnv recording every side effect. */
function fakeEnv(feed: () => string, served: () => Uint8Array = () => INSTALLER) {
	const files = new Map<string, Uint8Array>();
	const calls = {
		fetch: [] as string[],
		download: [] as { url: string; offset: number }[],
		installer: [] as { file: string; args: string[] }[],
		exit: [] as number[],
		removed: [] as string[],
	};
	let failInstaller: Error | undefined;
	let corruptNext = false;
	const env: UpdateEnv = {
		updatesDir: DIR,
		pid: 4242,
		async fetchText(url) {
			calls.fetch.push(url);
			return feed();
		},
		async download(url, dest, { offset, onProgress }) {
			calls.download.push({ url, offset });
			let body = served();
			if (corruptNext) {
				body = body.slice();
				body[10] = body[10]! ^ 0xff;
				corruptNext = false;
			}
			const prev = offset > 0 ? (files.get(dest) ?? new Uint8Array()) : new Uint8Array();
			const next = new Uint8Array(prev.length + body.length - offset);
			next.set(prev);
			next.set(body.slice(offset), prev.length);
			files.set(dest, next);
			onProgress(next.length, body.length);
		},
		async fileSize(p) {
			return files.get(p)?.length ?? null;
		},
		async sha256(p) {
			const f = files.get(p);
			if (!f) throw new Error("ENOENT");
			return sha(f);
		},
		async rename(a, b) {
			files.set(b, files.get(a)!);
			files.delete(a);
		},
		async remove(p) {
			calls.removed.push(p);
			files.delete(p);
		},
		async list() {
			return [...files.keys()].filter((k) => k.startsWith(DIR + "/")).map((k) => k.slice(DIR.length + 1));
		},
		runInstaller(file, args) {
			if (failInstaller) throw failInstaller;
			calls.installer.push({ file, args });
		},
		exit(code) {
			calls.exit.push(code);
		},
	};
	return {
		env,
		files,
		calls,
		failInstallerWith: (e: Error) => {
			failInstaller = e;
		},
		corruptNextDownload: () => {
			corruptNext = true;
		},
	};
}

function make(o: {
	feed: () => string;
	current?: string;
	settings?: Partial<UpdateSettings>;
	served?: () => Uint8Array;
	prepareExit?: () => Promise<void>;
}) {
	const f = fakeEnv(o.feed, o.served);
	const settings: UpdateSettings = { enabled: true, autoDownload: false, feedUrl: "https://example.org/latest.json", ...o.settings };
	const seen: UpdateModel[] = [];
	const u = createUpdater({
		currentVersion: o.current ?? "0.1.0+b7cd9fc4-20261106",
		publicKey: kp.publicKey,
		settings: () => settings,
		env: f.env,
		now: () => new Date("2026-12-02T00:00:00Z"),
		prepareExit: o.prepareExit,
		onChange: (m) => seen.push(m),
	});
	return { u, f, settings, seen };
}

describe("state machine (pure)", () => {
	const m = (version = "0.2.0") =>
		({ version, releasedAt: "x", notes: "", url: "https://e.org/a.exe", sha256: "a".repeat(64), size: 10, signature: "s" }) as Manifest;
	test("happy path", () => {
		let s = initialModel();
		s = reduce(s, { t: "check" });
		expect(s.state.kind).toBe("checking");
		s = reduce(s, { t: "checked", at: "t1", manifest: m() });
		expect(s.state.kind).toBe("available");
		expect(s.lastCheck).toEqual({ at: "t1", result: "available", version: "0.2.0" });
		s = reduce(s, { t: "download" });
		expect(s.state).toMatchObject({ kind: "downloading", received: 0, total: 10 });
		s = reduce(s, { t: "progress", received: 5, total: 10 });
		expect(s.state).toMatchObject({ received: 5 });
		s = reduce(s, { t: "downloaded", file: "f" });
		expect(s.state).toMatchObject({ kind: "ready", file: "f" });
		s = reduce(s, { t: "install" });
		expect(s.state.kind).toBe("installing");
	});
	test("events that do not fit are ignored (same object back)", () => {
		const idle = initialModel();
		for (const e of [
			{ t: "download" },
			{ t: "progress", received: 1, total: 2 },
			{ t: "downloaded", file: "f" },
			{ t: "install" },
			{ t: "checked", at: "t", manifest: null },
			{ t: "dismiss" },
		] as const)
			expect(reduce(idle, e)).toBe(idle);
		const ready = { ...initialModel(), state: { kind: "ready", manifest: m(), file: "f" } } as UpdateModel;
		expect(reduce(ready, { t: "check" })).toBe(ready);
		expect(reduce(ready, { t: "download" })).toBe(ready);
	});
	test("up to date, failure and dismiss", () => {
		let s = reduce(initialModel(), { t: "check" });
		s = reduce(s, { t: "check-failed", at: "t", message: "boom" });
		expect(s.state).toMatchObject({ kind: "error", phase: "check" });
		expect(s.lastCheck?.result).toBe("error");
		expect(reduce(s, { t: "dismiss" }).state.kind).toBe("idle");
		s = reduce(reduce(initialModel(), { t: "check" }), { t: "checked", at: "t", manifest: null });
		expect(s.state.kind).toBe("up-to-date");
		expect(s.lastCheck?.result).toBe("up-to-date");
	});
	test("a failed download keeps the manifest and can be retried; dismiss returns to available", () => {
		let s = reduce(reduce(reduce(initialModel(), { t: "check" }), { t: "checked", at: "t", manifest: m() }), { t: "download" });
		s = reduce(s, { t: "download-failed", message: "net" });
		expect(s.state).toMatchObject({ kind: "error", phase: "download" });
		expect(reduce(s, { t: "download" }).state.kind).toBe("downloading");
		expect(reduce(s, { t: "dismiss" }).state.kind).toBe("available");
	});
	test("manualOnly cannot be downloaded", () => {
		const s = reduce(reduce(initialModel(), { t: "check" }), { t: "checked", at: "t", manifest: m(), manualOnly: true });
		expect(reduce(s, { t: "download" })).toBe(s);
	});
	test("install-on-exit only while there is something to install; an up-to-date result clears it", () => {
		expect(reduce(initialModel(), { t: "install-on-exit", value: true }).installOnExit).toBe(false);
		let s = reduce(reduce(initialModel(), { t: "check" }), { t: "checked", at: "t", manifest: m() });
		s = reduce(s, { t: "install-on-exit", value: true });
		expect(s.installOnExit).toBe(true);
		expect(reduce(s, { t: "install-on-exit", value: false }).installOnExit).toBe(false);
	});
	test("cleanup plan touches only our installers and keeps the target", () => {
		const keep = installerName({ version: "0.3.0+abc12345-20261201", url: "https://e.org/a.exe" });
		expect(keep).toBe("zotero-next-0.3.0+abc12345-20261201-setup.exe");
		const files = [
			"zotero-next-0.1.0-setup.exe",
			"zotero-next-0.2.0-setup.exe.part",
			keep,
			`${keep}.part`,
			"notes.txt",
			"library.sqlite",
			"other-setup.exe",
		];
		expect(planCleanup(files, [keep]).sort()).toEqual(["zotero-next-0.1.0-setup.exe", "zotero-next-0.2.0-setup.exe.part"]);
		expect(planCleanup(files, []).sort()).toEqual(
			[keep, `${keep}.part`, "zotero-next-0.1.0-setup.exe", "zotero-next-0.2.0-setup.exe.part"].sort(),
		);
		expect(installerName({ version: "1", url: "https://e.org/x.cmd" })).toBe("zotero-next-1-setup.cmd");
		// nothing to keep + a running version: only downloads that are not newer than it go (a newer partial one can be resumed after a restart)
		expect(
			planCleanup(
				["zotero-next-0.1.0-setup.exe", "zotero-next-0.2.0-setup.exe.part", "zotero-next-0.0.5+abc12345-20260101-setup.exe"],
				[],
				"0.1.0+aaaaaaaa-20261106",
			).sort(),
		).toEqual(["zotero-next-0.0.5+abc12345-20260101-setup.exe", "zotero-next-0.1.0-setup.exe"]);
	});
});

describe("settings gate", () => {
	test("automatic check off: no fetch at all; manual check still goes out", async () => {
		const { u, f } = make({ feed: () => "{}", settings: { enabled: false } });
		await u.check({ manual: false });
		expect(f.calls.fetch).toEqual([]);
		expect(u.model().state.kind).toBe("idle");
		await u.check({ manual: true });
		expect(f.calls.fetch.length).toBe(1);
	});
	test("no feed URL: no fetch even for a manual check, with a clear message", async () => {
		const { u, f } = make({ feed: () => "{}", settings: { feedUrl: "" } });
		await u.check({ manual: false });
		expect(u.model().state.kind).toBe("idle");
		await u.check({ manual: true });
		expect(f.calls.fetch).toEqual([]);
		expect(u.model().state).toMatchObject({ kind: "error", phase: "check", code: "no-feed" });
	});
	test("a development build is not checked", async () => {
		const { u, f } = make({ feed: () => "{}", current: "dev" });
		await u.check({ manual: true });
		expect(f.calls.fetch).toEqual([]);
		expect(u.model().state).toMatchObject({ kind: "error", code: "disabled" });
	});
	test("the timer does nothing when the setting is off", async () => {
		const f = fakeEnv(() => "{}");
		const u = createUpdater({
			currentVersion: "0.1.0",
			publicKey: kp.publicKey,
			settings: () => ({ enabled: false, autoDownload: true, feedUrl: "https://e.org/l.json" }),
			env: f.env,
			firstDelayMs: 5,
			intervalMs: 10,
		});
		u.start();
		await Bun.sleep(60);
		u.stop();
		expect(f.calls.fetch).toEqual([]);
	});
	test("the timer checks when on, then stops", async () => {
		const m = await signed("0.1.0+b7cd9fc4-20261106");
		const f = fakeEnv(() => JSON.stringify(m));
		const u = createUpdater({
			currentVersion: "0.1.0+b7cd9fc4-20261106",
			publicKey: kp.publicKey,
			settings: () => ({ enabled: true, autoDownload: false, feedUrl: "https://e.org/l.json" }),
			env: f.env,
			firstDelayMs: 5,
			intervalMs: 20,
		});
		u.start();
		await Bun.sleep(150);
		u.stop();
		const n = f.calls.fetch.length;
		expect(n).toBeGreaterThanOrEqual(2);
		await Bun.sleep(80);
		expect(f.calls.fetch.length).toBe(n);
	});
});

describe("check", () => {
	test("newer version is offered, same or older is not", async () => {
		const newer = await signed("0.1.0+aaaaaaaa-20261107");
		let { u } = make({ feed: () => JSON.stringify(newer) });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "available" });
		expect(u.model().lastCheck).toMatchObject({ result: "available", version: "0.1.0+aaaaaaaa-20261107" });
		({ u } = make({ feed: () => JSON.stringify(newer), current: "0.1.0+bbbbbbbb-20261107" }));
		await u.check();
		expect(u.model().state.kind).toBe("up-to-date");
		({ u } = make({ feed: () => JSON.stringify(newer), current: "0.3.0" }));
		await u.check();
		expect(u.model().state.kind).toBe("up-to-date");
	});
	test("a bad signature, tampered manifest, garbage and a different key are all errors, never offered", async () => {
		const good = await signed("0.2.0");
		const cases = [
			JSON.stringify({ ...good, url: "https://evil.example/x.exe" }),
			"not json",
			JSON.stringify({ ...good, signature: "AAAA" }),
		];
		for (const text of cases) {
			const { u, f } = make({ feed: () => text });
			await u.check();
			expect(u.model().state.kind).toBe("error");
			expect(f.calls.download).toEqual([]);
		}
		const other = await generateKeyPair();
		const foreign = await signManifest(
			{
				version: "0.2.0",
				releasedAt: "2026-12-01T00:00:00Z",
				notes: "",
				url: "https://e.org/a.exe",
				sha256: "a".repeat(64),
				size: 1,
			},
			other.privateJwk,
		);
		const { u } = make({ feed: () => JSON.stringify(foreign) });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "error", code: "bad-signature" });
	});
	test("a fetch failure is reported, not thrown", async () => {
		const { u } = make({
			feed: () => {
				throw new UpdateError("network", "offline");
			},
		});
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "error", phase: "check", code: "network", message: "offline" });
	});
	test("minVersion above the installed version = manual update only", async () => {
		const m = await signed("0.5.0", { minVersion: "0.3.0" });
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "available", manualOnly: true });
		expect(f.calls.download).toEqual([]);
	});
});

describe("download + verify", () => {
	test("manual download verifies and renames the part file; old installers are removed", async () => {
		const m = await signed("0.2.0+11111111-20261201");
		const { u, f } = make({ feed: () => JSON.stringify(m) });
		f.files.set(`${DIR}/zotero-next-0.0.9-setup.exe`, new Uint8Array([1]));
		f.files.set(`${DIR}/readme.txt`, new Uint8Array([1]));
		await u.check();
		await Bun.sleep(10); // cleanup runs after the check
		expect(f.calls.removed).toEqual([`${DIR}/zotero-next-0.0.9-setup.exe`]);
		expect(f.files.has(`${DIR}/readme.txt`)).toBe(true);
		expect(f.calls.download).toEqual([]); // not automatic
		await u.download();
		const file = `${DIR}/zotero-next-0.2.0+11111111-20261201-setup.exe`;
		expect(u.model().state).toMatchObject({ kind: "ready", file });
		expect(f.files.has(file)).toBe(true);
		expect(f.files.has(`${file}.part`)).toBe(false);
	});
	test("download automatically: the check leads straight to ready", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		await u.check();
		expect(u.model().state.kind).toBe("ready");
		expect(f.calls.download.length).toBe(1);
	});
	test("sha256 mismatch: file deleted, error state, never ready or installed", async () => {
		const m = await signed("0.2.0", { sha256: "00".repeat(32) });
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "error", phase: "download", code: "hash-mismatch" });
		expect([...f.files.keys()].filter((k) => k.includes("setup"))).toEqual([]);
		await u.installNow();
		expect(f.calls.installer).toEqual([]);
		expect(f.calls.exit).toEqual([]);
	});
	test("size mismatch is rejected", async () => {
		const m = await signed("0.2.0", { size: INSTALLER.length + 1 });
		const { u } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		await u.check();
		expect(u.model().state).toMatchObject({ kind: "error", code: "size-mismatch" });
	});
	test("a partial file is resumed from its length", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		const part = `${DIR}/zotero-next-0.2.0-setup.exe.part`;
		f.files.set(part, INSTALLER.slice(0, 1200));
		await u.check();
		expect(f.calls.download).toEqual([{ url: m.url, offset: 1200 }]);
		expect(u.model().state.kind).toBe("ready");
	});
	test("a corrupt resumed file is dropped and the download starts over once", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		const part = `${DIR}/zotero-next-0.2.0-setup.exe.part`;
		f.files.set(part, new Uint8Array(1200).fill(9)); // not a prefix of the installer
		await u.check();
		expect(f.calls.download.map((d) => d.offset)).toEqual([1200, 0]);
		expect(u.model().state.kind).toBe("ready");
	});
	test("an intact earlier download is reused without any transfer", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		f.files.set(`${DIR}/zotero-next-0.2.0-setup.exe`, INSTALLER.slice());
		await u.check();
		expect(f.calls.download).toEqual([]);
		expect(u.model().state.kind).toBe("ready");
	});
});

describe("apply", () => {
	test("install now: prepareExit first, then the installer with silent + relaunch args, then exit", async () => {
		const m = await signed("0.2.0");
		const order: string[] = [];
		const { u, f } = make({
			feed: () => JSON.stringify(m),
			settings: { autoDownload: true },
			prepareExit: async () => {
				order.push("prepare");
			},
		});
		const run = f.env.runInstaller,
			ex = f.env.exit;
		f.env.runInstaller = (file, args) => {
			order.push("installer");
			return run(file, args);
		};
		f.env.exit = (c) => {
			order.push("exit");
			ex(c);
		};
		await u.check();
		await u.installNow();
		expect(order).toEqual(["prepare", "installer", "exit"]);
		expect(f.calls.installer).toEqual([
			{ file: `${DIR}/zotero-next-0.2.0-setup.exe`, args: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/ZNRELAUNCH"] },
		]);
		expect(f.calls.exit).toEqual([0]);
		expect(u.model().state.kind).toBe("installing");
		await u.installNow(); // a second click does nothing
		expect(f.calls.installer.length).toBe(1);
	});
	test("install now downloads first when the update is only available", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m) });
		await u.check();
		await u.installNow();
		expect(f.calls.download.length).toBe(1);
		expect(f.calls.installer.length).toBe(1);
	});
	test("the installer file is verified again right before it runs", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		await u.check();
		const file = `${DIR}/zotero-next-0.2.0-setup.exe`;
		const tampered = INSTALLER.slice();
		tampered[0] = tampered[0]! ^ 1;
		f.files.set(file, tampered);
		await u.installNow();
		expect(f.calls.installer).toEqual([]);
		expect(f.calls.exit).toEqual([]);
		expect(u.model().state).toMatchObject({ kind: "error", phase: "install", code: "hash-mismatch" });
	});
	test("installer failing to start keeps the app running and reports", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
		f.failInstallerWith(new Error("EACCES"));
		await u.check();
		await u.installNow();
		expect(f.calls.exit).toEqual([]);
		expect(u.model().state).toMatchObject({ kind: "error", phase: "install", code: "installer" });
	});
	test("install on exit: armed + verified + normal exit starts the installer without the relaunch flag, once", async () => {
		const m = await signed("0.2.0");
		const { u, f } = make({ feed: () => JSON.stringify(m) });
		await u.check();
		await u.setInstallOnExit(true); // downloads
		expect(u.model()).toMatchObject({ installOnExit: true, state: { kind: "ready" } });
		await u.prepareForExit();
		u.onExit(0);
		u.onExit(0);
		expect(f.calls.installer).toEqual([
			{ file: `${DIR}/zotero-next-0.2.0-setup.exe`, args: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"] },
		]);
		expect(f.calls.exit).toEqual([]);
	});
	test("install on exit does nothing on a crash exit, when not armed, or when not verified", async () => {
		const m = await signed("0.2.0");
		{
			const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
			await u.check();
			await u.prepareForExit();
			u.onExit(0);
			expect(f.calls.installer).toEqual([]);
		}
		{
			const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
			await u.check();
			await u.setInstallOnExit(true);
			await u.prepareForExit();
			u.onExit(1);
			expect(f.calls.installer).toEqual([]);
		}
		{
			const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
			await u.check();
			await u.setInstallOnExit(true);
			u.onExit(0);
			expect(f.calls.installer).toEqual([]);
		}
		{
			// file tampered between download and quit
			const { u, f } = make({ feed: () => JSON.stringify(m), settings: { autoDownload: true } });
			await u.check();
			await u.setInstallOnExit(true);
			f.files.set(`${DIR}/zotero-next-0.2.0-setup.exe`, new Uint8Array(INSTALLER.length));
			await u.prepareForExit();
			u.onExit(0);
			expect(f.calls.installer).toEqual([]);
		}
	});
	test("installer args: override and placeholders", () => {
		expect(installerArgs({ pid: 7, file: "C:/x.exe", relaunch: true }, "")).toEqual([
			"/VERYSILENT",
			"/SUPPRESSMSGBOXES",
			"/NORESTART",
			"/ZNRELAUNCH",
		]);
		expect(installerArgs({ pid: 7, file: "C:/x.exe", relaunch: false }, JSON.stringify(["--silent", "--pid={pid}"]))).toEqual([
			"--silent",
			"--pid=7",
		]);
		expect(installerArgs({ pid: 7, file: "C:/x.exe", relaunch: true }, "not json")).toEqual([
			"/VERYSILENT",
			"/SUPPRESSMSGBOXES",
			"/NORESTART",
			"/ZNRELAUNCH",
		]);
	});
});
