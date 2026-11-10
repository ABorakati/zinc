// End to end against a local Bun.serve feed (127.0.0.1, free port): the real UpdateEnv (fetch, files, process spawn), a signed manifest
// and a stub installer (.cmd that writes its arguments to a marker file). Run with ZN_E2E_OUT=<folder> to keep the evidence there
// (e2e-report.txt, the stubs and downloads); otherwise a temp folder is used. Not the GUI: the updater module only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv } from "../../src/update/env";
import { generateKeyPair } from "../../src/update/manifest";
import { createUpdater, type UpdateSettings } from "../../src/update/updater";
import type { UpdateModel } from "../../src/update/machine";
import { scratch, startFeed, stubInstaller, type Feed } from "./fixture";

const OUT = process.env.ZN_E2E_OUT ?? join(tmpdir(), "zn-update-e2e");
mkdirSync(OUT, { recursive: true });
const REPORT = join(OUT, "e2e-report.txt");
writeFileSync(REPORT, `update e2e ${new Date().toISOString()}\n`);
const say = (s: string) => { appendFileSync(REPORT, s + "\n"); };

const CURRENT = "0.1.0+b7cd9fc4-20261106";
const NEXT = "0.2.0+1a2b3c4d-20261201";
const feeds: Feed[] = [];
afterAll(() => { for (const f of feeds) f.stop(); });

async function waitFor(cond: () => boolean, ms = 8000) {
	const t0 = Date.now();
	while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await Bun.sleep(25); }
}

function setup(name: string, feed: Feed, settings: Partial<UpdateSettings> = {}) {
	const dir = scratch(OUT, name);
	const updatesDir = join(dir, "updates");
	const marker = join(dir, "marker.txt");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(updatesDir, { recursive: true });
	process.env.ZN_STUB_MARKER = marker;
	const exits: number[] = [];
	const trace: string[] = [];
	const u = createUpdater({
		currentVersion: CURRENT, publicKey: feed.keys.publicKey, env: createRealEnv({ updatesDir, exit: (c) => void exits.push(c) }),
		settings: () => ({ enabled: true, autoDownload: false, feedUrl: feed.url, ...settings }),
		prepareExit: async () => { trace.push("prepareExit"); },
		onChange: (m: UpdateModel) => { const k = m.state.kind; if (trace[trace.length - 1] !== k) trace.push(k); },
	});
	return { u, dir, updatesDir, marker, exits, trace };
}

// The stub installer is a Windows .cmd file, and the updater runs the Windows installer: nothing to run elsewhere.
describe.skipIf(process.platform !== "win32")("update e2e (local feed)", () => {
	test("detect -> download -> verify -> apply with the silent arguments", async () => {
		const installer = stubInstaller("full");
		const feed = await startFeed({ version: NEXT, installer, notes: "# 0.2.0\n- auto-update" });
		feeds.push(feed);
		const { u, updatesDir, marker, exits, trace } = setup("full", feed);

		await u.check({ manual: true });
		say(`detect: state=${u.model().state.kind} latest=${NEXT} lastCheck=${JSON.stringify(u.model().lastCheck)}`);
		expect(u.model().state).toMatchObject({ kind: "available", manifest: { version: NEXT } });
		expect(feed.requests).toEqual(["GET /latest.json"]);

		await u.download();
		const file = join(updatesDir, `zotero-next-${NEXT}-setup.cmd`).replaceAll("\\", "/");
		say(`download: state=${u.model().state.kind} file=${file} size=${installer.length} requests=${JSON.stringify(feed.requests)}`);
		expect(u.model().state).toMatchObject({ kind: "ready", file });
		expect(existsSync(file)).toBe(true);
		expect(existsSync(`${file}.part`)).toBe(false);

		await u.installNow();
		await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").includes("TAG="));
		const got = readFileSync(marker, "utf8");
		say(`apply: marker=\n${got.trim()}\nexit codes=${JSON.stringify(exits)} transitions=${trace.join(" > ")}`);
		expect(got).toContain("ARGS=/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH");
		expect(got).toContain("TAG=full");
		expect(got.toLowerCase()).toContain(`zotero-next-${NEXT}-setup.cmd`.toLowerCase());
		expect(exits).toEqual([0]);
		expect(trace).toEqual(["checking", "available", "downloading", "ready", "installing", "prepareExit"]);
	});

	test("resumes a partial download with a Range request", async () => {
		const installer = stubInstaller("resume");
		const feed = await startFeed({ version: NEXT, installer });
		feeds.push(feed);
		const { u, updatesDir } = setup("resume", feed);
		const part = join(updatesDir, `zotero-next-${NEXT}-setup.cmd.part`);
		writeFileSync(part, installer.slice(0, 100_000));
		await u.check({ manual: true });
		await u.download();
		say(`resume: requests=${JSON.stringify(feed.requests)}`);
		expect(feed.requests).toContain("GET /files/setup.cmd range=bytes=100000-");
		expect(u.model().state.kind).toBe("ready");
		expect(readFileSync(join(updatesDir, `zotero-next-${NEXT}-setup.cmd`)).length).toBe(installer.length);
	});

	test("a corrupt partial file is discarded and the download restarts", async () => {
		const installer = stubInstaller("badpart");
		const feed = await startFeed({ version: NEXT, installer });
		feeds.push(feed);
		const { u, updatesDir } = setup("badpart", feed);
		writeFileSync(join(updatesDir, `zotero-next-${NEXT}-setup.cmd.part`), new Uint8Array(50_000).fill(65));
		await u.check({ manual: true });
		await u.download();
		say(`badpart: requests=${JSON.stringify(feed.requests)}`);
		expect(u.model().state.kind).toBe("ready");
		expect(feed.requests.filter((r) => r.includes("setup.cmd")).length).toBe(2); // resumed attempt, then from scratch
	});

	test("a tampered installer on the server is rejected and never run", async () => {
		const feed = await startFeed({ version: NEXT, installer: stubInstaller("tamper") });
		feed.tamperInstaller = true;
		feeds.push(feed);
		const { u, updatesDir, marker, exits } = setup("tamper", feed);
		await u.check({ manual: true });
		await u.download();
		say(`tampered installer: state=${JSON.stringify({ ...u.model().state, manifest: undefined })}`);
		expect(u.model().state).toMatchObject({ kind: "error", phase: "download", code: "hash-mismatch" });
		expect(existsSync(join(updatesDir, `zotero-next-${NEXT}-setup.cmd`))).toBe(false);
		await u.installNow();
		await Bun.sleep(300);
		expect(existsSync(marker)).toBe(false);
		expect(exits).toEqual([]);
	});

	test("a forged manifest (changed url) is rejected: signature fails, no installer request", async () => {
		const feed = await startFeed({ version: NEXT, installer: stubInstaller("forged") });
		feed.manifestOverride = JSON.stringify({ ...feed.manifest, url: "http://127.0.0.1:1/evil.cmd" });
		feeds.push(feed);
		const { u } = setup("forged", feed);
		await u.check({ manual: true });
		say(`forged manifest: ${JSON.stringify({ kind: u.model().state.kind, code: (u.model().state as { code?: string }).code })}`);
		expect(u.model().state).toMatchObject({ kind: "error", code: "bad-signature" });
		expect(feed.requests).toEqual(["GET /latest.json"]);
	});

	test("a manifest signed by another key is rejected", async () => {
		const feed = await startFeed({ version: NEXT, installer: stubInstaller("otherkey") });
		feeds.push(feed);
		const { u } = setup("otherkey", { ...feed, keys: await generateKeyPair() });
		await u.check({ manual: true });
		expect(u.model().state).toMatchObject({ kind: "error", code: "bad-signature" });
	});

	test("settings off / no feed: not a single request reaches the server", async () => {
		const feed = await startFeed({ version: NEXT, installer: stubInstaller("off") });
		feeds.push(feed);
		const off = setup("off", feed, { enabled: false });
		await off.u.check({ manual: false });
		off.u.start();
		const noFeed = setup("nofeed", feed, { feedUrl: "" });
		await noFeed.u.check({ manual: true });
		await noFeed.u.check({ manual: false });
		await Bun.sleep(100);
		off.u.stop();
		say(`settings off / no feed: requests=${JSON.stringify(feed.requests)}`);
		expect(feed.requests).toEqual([]);
		expect(off.u.model().state.kind).toBe("idle");
	});

	test("up to date: no download, no installer", async () => {
		const feed = await startFeed({ version: "0.1.0+b7cd9fc4-20261106", installer: stubInstaller("same") });
		feeds.push(feed);
		const { u } = setup("same", feed);
		await u.check({ manual: true });
		expect(u.model().state.kind).toBe("up-to-date");
		expect(feed.requests).toEqual(["GET /latest.json"]);
	});

	test("install on exit: a child process quits normally and the installer starts without /RELAUNCH", async () => {
		const feed = await startFeed({ version: NEXT, installer: stubInstaller("onexit") });
		feeds.push(feed);
		const dir = scratch(OUT, "onexit");
		rmSync(dir, { recursive: true, force: true });
		const updatesDir = join(dir, "updates");
		const marker = join(dir, "marker.txt");
		mkdirSync(dir, { recursive: true });
		// async spawn: the feed is served by THIS process, so its event loop must stay free while the child talks to it
		const run = async (exitCode: number) => {
			const p = Bun.spawn([process.execPath, join(import.meta.dir, "exit-fixture.ts")], {
				env: { ...process.env, ZN_STUB_MARKER: marker, ZN_FIXTURE: JSON.stringify({ feedUrl: feed.url, publicKey: feed.keys.publicKey, updatesDir, version: CURRENT, exitCode }) },
				stdout: "pipe", stderr: "pipe",
			});
			const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
			return { stdout: out, exitCode: p.exitCode };
		};

		const crash = await run(1);
		await Bun.sleep(500);
		say(`install on exit, crash exit (code 1): child said "${crash.stdout.trim()}", marker exists=${existsSync(marker)}`);
		expect(existsSync(marker)).toBe(false);

		const ok = await run(0);
		say(`install on exit, normal exit: child said "${ok.stdout.trim()}" exit=${ok.exitCode}`);
		expect(ok.stdout).toContain("state: ready installOnExit: true");
		await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").includes("TAG="));
		const got = readFileSync(marker, "utf8");
		say(`install on exit marker:\n${got.trim()}`);
		expect(got).toContain("ARGS=/VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
		expect(got).not.toContain("RELAUNCH");
		expect(got).toContain("TAG=onexit");
	}, 30_000);
});
