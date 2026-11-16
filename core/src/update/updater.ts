// The updater: check a signed feed, download + verify the installer, hand it to the installer. All decisions live here and in the
// pure modules next to it (version.ts, manifest.ts, machine.ts); everything with a side effect (network, files, starting a process,
// exiting) goes through the injectable UpdateEnv, so the tests drive it with fakes and the e2e test with the real env.ts.
//
// Rules:
//   - No feed URL configured: no network at all (a manual "Check now" just says so).
//   - "Check automatically" off: no automatic check (the timer does nothing). "Check now" is an explicit action and still checks.
//   - A manifest is trusted only after its Ed25519 signature verified against the embedded public key. A download is trusted only after
//     its size and sha256 match the (signed) manifest; a mismatch deletes the file. The installer is verified AGAIN just before it runs.
//   - Never blocks: every method is async; the UI only reads the model through onChange.
import { logInfo, logWarn } from "../log";
import { type Manifest, UpdateError, verifyManifest } from "./manifest";
import { type LastCheck, type UpdateEvent, type UpdateModel, initialModel, installerName, planCleanup, reduce } from "./machine";
import { isNewer, parseVersion, compareVersions } from "./version";

export interface UpdateSettings {
	/** "Check automatically". */
	enabled: boolean;
	/** "Download automatically" (off by default): the installer is fetched as soon as a check finds one. */
	autoDownload: boolean;
	/** The manifest URL (https; empty = updates off). */
	feedUrl: string;
}

/** The OS side of the updater. env.ts is the real one. */
export interface UpdateEnv {
	/** %LOCALAPPDATA%\zotero-next-gpui\updates (created on demand). */
	updatesDir: string;
	/** Id of this process (handed to the installer so it can wait for the app to end). */
	pid: number;
	/** GET a small text body (the manifest). Throws UpdateError("network" | "http" | "too-large"). */
	fetchText(url: string, o: { maxBytes: number }): Promise<string>;
	/** GET `url` into `dest`; when `offset` > 0 the file already holds that many bytes and the transfer continues after them (Range), or starts over if the server cannot. */
	download(url: string, dest: string, o: { offset: number; onProgress: (received: number, total: number) => void }): Promise<void>;
	fileSize(path: string): Promise<number | null>;
	sha256(path: string): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	list(dir: string): Promise<string[]>;
	/** Start the installer detached (it outlives this process). Called with the full argument list. */
	runInstaller(file: string, args: string[]): void | Promise<void>;
	/** End the app (the real one goes through process.exit, whose hook runs the shutdown closers). */
	exit(code: number): void;
}

export interface UpdaterDeps {
	/** The running build's version (process.env.ZN_VERSION); "dev" or anything unparseable = never updated. */
	currentVersion: string;
	/** Raw Ed25519 public key, base64; empty = this build cannot verify anything, so it never updates. */
	publicKey: string;
	settings: () => UpdateSettings;
	env: UpdateEnv;
	now?: () => Date;
	/** "Install now": wait for pending writes and close the database (services.ts shutdown()). Runs before the installer starts. */
	prepareExit?: () => Promise<void>;
	/** Persisted result of the last check (restored at start; also spaces the 24 h timer across restarts). */
	lastCheck?: LastCheck;
	onChange?: (m: UpdateModel) => void;
	/** Default 24 h. */
	intervalMs?: number;
	/** Delay of the first automatic check after start() (default 20 s: after start-up has settled). */
	firstDelayMs?: number;
}

/**
 * Silent installer command line: the Inno Setup switches of gpui-ui/installer/zotero-next.iss (/VERYSILENT /SUPPRESSMSGBOXES /NORESTART;
 * the installer closes a running Zinc itself, and our process is already gone or going), plus "/ZNRELAUNCH" for "Install now":
 * start the app again when done. TODO(installer): the .iss [Run] entry has "skipifsilent" and does not know /ZNRELAUNCH yet; add
 * `Filename: "{app}zotero-next-gpui.exe"; Flags: nowait; Check: RelaunchRequested` (true when CmdLineParamExists('/ZNRELAUNCH')) so a
 * silent update restarts the app. Install-on-exit never passes it (the user quit on purpose). ZN_INSTALLER_ARGS (a JSON array, may use
 * the placeholders {pid} and {file}) overrides the whole list without a rebuild.
 */
export function installerArgs(o: { pid: number; file: string; relaunch: boolean }, override = process.env.ZN_INSTALLER_ARGS): string[] {
	if (override) {
		try {
			const a = JSON.parse(override) as unknown;
			if (Array.isArray(a) && a.every((x) => typeof x === "string"))
				return (a as string[]).map((x) => x.replaceAll("{pid}", String(o.pid)).replaceAll("{file}", o.file));
		} catch {
			/* fall through to the default */
		}
	}
	return ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", ...(o.relaunch ? ["/ZNRELAUNCH"] : [])];
}

export interface Updater {
	model(): UpdateModel;
	/** Check the feed. `manual`: an explicit "Check now" (ignores the "Check automatically" setting, never the missing feed). */
	check(o?: { manual?: boolean }): Promise<UpdateModel>;
	/** Download + verify the installer of the available update (no-op when there is none / it is already downloaded). */
	download(): Promise<UpdateModel>;
	/** Close the app cleanly, run the installer silently with the relaunch flag, exit. */
	installNow(): Promise<UpdateModel>;
	/** Arm / disarm "install when the app is closed normally" (downloads first if needed). */
	setInstallOnExit(v: boolean): Promise<UpdateModel>;
	/** Async half of install-on-exit: call from a shutdown closer. Re-verifies the installer so onExit can stay synchronous. */
	prepareForExit(): Promise<void>;
	/** Sync half: call from process.on("exit"). Starts the installer (no relaunch) when armed + verified and the exit is a normal one. */
	onExit(code: number): void;
	/** Start the timer (first check after firstDelayMs, then every intervalMs). */
	start(): void;
	stop(): void;
	/** Delete old installer downloads (everything of ours but the current target). */
	cleanup(): Promise<string[]>;
}

const DAY = 24 * 3600 * 1000;
const MAX_MANIFEST = 256 * 1024;
const errCode = (e: unknown) => (e instanceof UpdateError ? e.code : undefined);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createUpdater(deps: UpdaterDeps): Updater {
	const { env } = deps;
	const now = deps.now ?? (() => new Date());
	let model = initialModel(deps.lastCheck);
	let inflight: Promise<unknown> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = false; // the installer was started (by install-now or on exit): never twice
	let exitVerified = false;

	const dispatch = (e: UpdateEvent): UpdateModel => {
		const next = reduce(model, e);
		if (next !== model) {
			model = next;
			try {
				deps.onChange?.(model);
			} catch {
				/* a listener must not break the updater */
			}
		}
		return model;
	};
	const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
		const p = f().finally(() => {
			if (inflight === p) inflight = undefined;
		});
		inflight = p;
		return p;
	};
	const updatable = () => !!parseVersion(deps.currentVersion);
	const target = (m: Manifest) => `${env.updatesDir}/${installerName(m)}`.replaceAll("\\", "/");

	async function verifyFile(file: string, m: Manifest): Promise<void> {
		const size = await env.fileSize(file);
		if (size !== m.size) throw new UpdateError("size-mismatch", `the installer is ${size ?? 0} bytes, the manifest says ${m.size}`);
		if ((await env.sha256(file)).toLowerCase() !== m.sha256)
			throw new UpdateError("hash-mismatch", "the installer's SHA-256 does not match the manifest");
	}

	async function cleanup(): Promise<string[]> {
		try {
			const s = model.state;
			const keep = "manifest" in s && s.manifest ? [installerName(s.manifest)] : [];
			const gone = planCleanup(await env.list(env.updatesDir), keep, deps.currentVersion);
			for (const f of gone) await env.remove(`${env.updatesDir}/${f}`.replaceAll("\\", "/")).catch(() => {});
			if (gone.length) logInfo("update", "removed old installer downloads", { count: gone.length });
			return gone;
		} catch (e) {
			logWarn("update", `cleanup failed: ${errMsg(e)}`);
			return [];
		}
	}

	function check(o: { manual?: boolean } = {}): Promise<UpdateModel> {
		const s = deps.settings();
		if (!o.manual && !s.enabled) return Promise.resolve(model); // automatic checks are off: no network
		const k = model.state.kind;
		if (inflight || k === "checking" || k === "downloading" || k === "installing" || k === "ready") return Promise.resolve(model);
		const at = () => now().toISOString();
		if (!s.feedUrl.trim()) {
			if (o.manual)
				(dispatch({ t: "check" }),
					dispatch({ t: "check-failed", at: at(), message: "No update feed is configured.", code: "no-feed" }));
			return Promise.resolve(model);
		}
		if (!updatable()) {
			if (o.manual)
				(dispatch({ t: "check" }),
					dispatch({
						t: "check-failed",
						at: at(),
						message: "This is a development build; it is not updated automatically.",
						code: "disabled",
					}));
			return Promise.resolve(model);
		}
		return exclusive(async () => {
			dispatch({ t: "check" });
			try {
				if (!deps.publicKey) throw new UpdateError("no-key", "This build has no update public key, so updates cannot be verified.");
				const text = await env.fetchText(s.feedUrl.trim(), { maxBytes: MAX_MANIFEST });
				let json: unknown;
				try {
					json = JSON.parse(text);
				} catch {
					throw new UpdateError("malformed", "bad update manifest: not JSON");
				}
				const m = await verifyManifest(json, deps.publicKey);
				const newer = isNewer(m.version, deps.currentVersion);
				const manualOnly = newer && !!m.minVersion && compareVersions(deps.currentVersion, m.minVersion) < 0;
				dispatch({ t: "checked", at: at(), manifest: newer ? m : null, manualOnly });
				logInfo("update", newer ? "update available" : "up to date", {
					current: deps.currentVersion,
					latest: m.version,
					manualOnly,
				});
			} catch (e) {
				logWarn("update", `check failed: ${errMsg(e)}`, { code: errCode(e) ?? null });
				dispatch({ t: "check-failed", at: at(), message: errMsg(e), code: errCode(e) });
				return;
			}
			void cleanup();
			if (s.autoDownload && model.state.kind === "available" && !model.state.manualOnly) await downloadInner();
		}).then(() => model);
	}

	async function downloadInner(): Promise<void> {
		dispatch({ t: "download" });
		const st = model.state;
		if (st.kind !== "downloading") return;
		const m = st.manifest;
		const final = target(m);
		const part = `${final}.part`;
		try {
			// already downloaded and intact (an earlier run): nothing to fetch
			if ((await env.fileSize(final)) !== null) {
				try {
					await verifyFile(final, m);
					dispatch({ t: "downloaded", file: final });
					logInfo("update", "installer already downloaded", { version: m.version });
					return;
				} catch {
					await env.remove(final);
				}
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				let offset = (await env.fileSize(part)) ?? 0;
				if (offset > m.size) {
					await env.remove(part);
					offset = 0;
				}
				logInfo("update", offset ? "resuming download" : "downloading", { version: m.version, offset, size: m.size });
				let last = 0;
				if (offset < m.size) {
					await env.download(m.url, part, {
						offset,
						onProgress: (r, t) => {
							const n = Date.now();
							if (n - last > 100 || r >= t) {
								last = n;
								dispatch({ t: "progress", received: r, total: t || m.size });
							}
						},
					});
				}
				try {
					await verifyFile(part, m);
				} catch (e) {
					await env.remove(part).catch(() => {});
					if (offset > 0 && attempt === 0) {
						logWarn("update", `resumed download failed verification (${errMsg(e)}); starting over`);
						continue;
					}
					throw e;
				}
				await env.rename(part, final);
				dispatch({ t: "downloaded", file: final });
				logInfo("update", "installer downloaded and verified", { version: m.version });
				return;
			}
		} catch (e) {
			logWarn("update", `download failed: ${errMsg(e)}`, { code: errCode(e) ?? null });
			dispatch({ t: "download-failed", message: errMsg(e), code: errCode(e) });
		}
	}

	const download = (): Promise<UpdateModel> => {
		if (inflight)
			return inflight.then(
				() => model,
				() => model,
			);
		const s = model.state;
		const can = (s.kind === "available" && !s.manualOnly) || (s.kind === "error" && s.phase !== "check" && !!s.manifest);
		if (!can) return Promise.resolve(model);
		return exclusive(downloadInner).then(() => model);
	};

	async function installNow(): Promise<UpdateModel> {
		if (model.state.kind === "available" || model.state.kind === "error") await download();
		if (inflight) await inflight.catch(() => {});
		const st = model.state;
		if (st.kind !== "ready" || started) return model;
		const { manifest, file } = st;
		try {
			await verifyFile(file, manifest); // again, right before running it
		} catch (e) {
			await env.remove(file).catch(() => {});
			dispatch({ t: "install" });
			dispatch({ t: "install-failed", message: errMsg(e), code: errCode(e) });
			return model;
		}
		dispatch({ t: "install" });
		logInfo("update", "installing: closing the app", { version: manifest.version });
		try {
			await deps.prepareExit?.();
			started = true;
			const args = installerArgs({ pid: env.pid, file, relaunch: true });
			logInfo("update", "starting the installer", { version: manifest.version, args: args.join(" ") });
			await env.runInstaller(file, args);
		} catch (e) {
			started = false;
			logWarn("update", `could not start the installer: ${errMsg(e)}`);
			dispatch({ t: "install-failed", message: `Could not start the installer: ${errMsg(e)}`, code: "installer" });
			return model;
		}
		env.exit(0);
		return model;
	}

	async function setInstallOnExit(v: boolean): Promise<UpdateModel> {
		dispatch({ t: "install-on-exit", value: v });
		if (v && model.installOnExit && model.state.kind === "available") await download();
		return model;
	}

	async function prepareForExit(): Promise<void> {
		exitVerified = false;
		const st = model.state;
		if (!model.installOnExit || st.kind !== "ready" || started) return;
		try {
			await verifyFile(st.file, st.manifest);
			exitVerified = true;
		} catch (e) {
			logWarn("update", `install on exit skipped: ${errMsg(e)}`);
		}
	}

	function onExit(code: number): void {
		const st = model.state;
		if (started || code !== 0 || !model.installOnExit || !exitVerified || st.kind !== "ready") return;
		started = true;
		try {
			const args = installerArgs({ pid: env.pid, file: st.file, relaunch: false });
			logInfo("update", "starting the installer on exit", { version: st.manifest.version, args: args.join(" ") });
			void env.runInstaller(st.file, args);
		} catch (e) {
			logWarn("update", `could not start the installer on exit: ${errMsg(e)}`);
		}
	}

	function schedule(ms: number) {
		timer = setTimeout(
			() => {
				void check({ manual: false }).finally(() => {
					if (timer !== undefined) schedule(deps.intervalMs ?? DAY);
				});
			},
			Math.max(0, ms),
		);
		(timer as { unref?: () => void }).unref?.();
	}
	function start() {
		if (timer !== undefined) return;
		const interval = deps.intervalMs ?? DAY;
		const first = deps.firstDelayMs ?? 20_000;
		const lastAt = model.lastCheck ? Date.parse(model.lastCheck.at) : NaN;
		const due = Number.isFinite(lastAt) ? lastAt + interval - now().getTime() : 0;
		schedule(Math.max(first, due));
	}
	function stop() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	return { model: () => model, check, download, installNow, setInstallOnExit, prepareForExit, onExit, start, stop, cleanup };
}
