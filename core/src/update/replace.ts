// How Zinc replaces itself on Linux and macOS, where there is no installer to run (Windows: updater.ts runs the Inno Setup installer).
//
//   Linux (AppImage)  The runtime sets APPIMAGE to the .AppImage file. The update is downloaded NEXT to it (same folder, so same file
//                     system), verified, made executable, and at exit renamed over $APPIMAGE: one atomic rename. The running app keeps
//                     its old file open, so this is safe while it shuts down. "Install now" then starts the new file once this pid is gone.
//   macOS (Zinc.app)  The update is Zinc.app zipped (ditto -c -k --keepParent). It is downloaded to the updates folder, verified, and
//                     unpacked to <folder of Zinc.app>/.zinc-update/ (same volume), its quarantine flag removed and its signature checked
//                     (re-signed ad hoc only if that fails). At exit a detached helper script waits for this pid, moves the old bundle
//                     into .zinc-update/, moves the new one into its place (putting the old one back if that fails), deletes
//                     .zinc-update/ and, for "Install now", starts Zinc again with `open`. It logs to <updates folder>/apply.log.
//   Neither           When this copy cannot replace itself (not an AppImage, not inside an .app, a folder it cannot write, an app that
//                     macOS runs from a translocated read-only copy), the update is offered as "install by hand" with the reason.
//
// Everything that starts a process goes through injectable functions so the tests run it with fakes and temporary folders.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { access, chmod, constants, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Manifest } from "./manifest";
import { type UpdatePlatform, currentPlatform } from "./platform";

/** One platform's way of putting a verified download in place. updater.ts calls it; env.ts carries it (UpdateEnv.replace). */
export interface SelfReplace {
	platform: UpdatePlatform;
	/** Where downloads go when they must be on the same file system as what they replace (Linux: the AppImage's folder). Default: the updates folder. */
	downloadDir?: string;
	/** null: this copy can replace itself. Otherwise why not, for the UI; the update is then offered as "install by hand". */
	manualReason(): Promise<string | null>;
	/** After the download is verified, before the app closes (async): make it runnable, unpack it. Throws to refuse the update. */
	prepare(file: string, m: Manifest): Promise<void>;
	/** Synchronous, because it runs in process.on("exit"): put the new version in place, or start the helper that does once `pid` is gone.
	 *  `relaunch`: start Zinc again afterwards ("Install now"). Throws when it could not. */
	apply(file: string, o: { relaunch: boolean; pid: number }): void;
	/** What an interrupted update left behind (macOS: .zinc-update/). Called at start-up, never while an update is ready. */
	cleanupStale?(): Promise<void>;
}

export interface ReplaceDeps {
	/** Start a detached process that outlives this one. */
	spawn?: (cmd: string, args: string[], o?: { env?: Record<string, string | undefined> }) => void;
	/** Run a command and wait for it: its exit code. */
	exec?: (cmd: string, args: string[]) => Promise<number>;
	/** Can this process create, rename and delete entries in `path`? */
	canWrite?: (path: string) => Promise<boolean>;
}

const realSpawn: NonNullable<ReplaceDeps["spawn"]> = (cmd, args, o) => {
	const child = nodeSpawn(cmd, args, { detached: true, stdio: "ignore", ...(o?.env ? { env: o.env } : {}) });
	child.on("error", () => {});
	child.unref();
};
const realExec: NonNullable<ReplaceDeps["exec"]> = (cmd, args) =>
	new Promise((resolve) => {
		const child = nodeSpawn(cmd, args, { stdio: "ignore" });
		child.on("error", () => resolve(127));
		child.on("exit", (code) => resolve(code ?? 1));
	});
const realCanWrite = (p: string) =>
	access(p, constants.W_OK).then(
		() => true,
		() => false,
	);

/** Single-quote a string for sh. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

// ------------------------------------------------------------------------------------------------------------ Linux: the AppImage

/** sh -c program: wait until pid $1 is gone (at most ~2 min), then run $2. */
export const WAIT_THEN_EXEC = 'i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 600 ] && exit 1; sleep 0.2; done; exec "$2"';

/**
 * The environment for the restarted AppImage: this one minus what the old AppImage's runtime and AppRun added (APPIMAGE, APPDIR, ARGV0,
 * OWD, and LD_LIBRARY_PATH entries inside the old mount, which is gone by then). The new runtime sets its own.
 */
export function relaunchEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const { APPIMAGE: _a, APPDIR, ARGV0: _v, OWD: _o, ...rest } = env;
	if (APPDIR && rest.LD_LIBRARY_PATH) {
		const kept = rest.LD_LIBRARY_PATH.split(":").filter((p) => p && p !== APPDIR && !p.startsWith(`${APPDIR}/`));
		if (kept.length) rest.LD_LIBRARY_PATH = kept.join(":");
		else delete rest.LD_LIBRARY_PATH;
	}
	return rest;
}

export function appImageReplace(o: { appimage: string; env?: Record<string, string | undefined> } & ReplaceDeps): SelfReplace {
	const dir = dirname(o.appimage);
	const spawn = o.spawn ?? realSpawn;
	const canWrite = o.canWrite ?? realCanWrite;
	return {
		platform: "linux-x64",
		downloadDir: dir,
		async manualReason() {
			if (!existsSync(o.appimage))
				return `The AppImage ${o.appimage} is not there any more, so Zinc cannot replace it. Download the new AppImage by hand.`;
			if (!(await canWrite(dir)))
				return `Zinc cannot write to ${dir}, so it cannot replace its AppImage. Download the new AppImage and replace the old file by hand.`;
			return null;
		},
		async prepare(file) {
			await chmod(file, 0o755);
		},
		apply(file, { relaunch, pid }) {
			renameSync(file, o.appimage); // same folder: atomic; the running app keeps the old file open
			if (relaunch)
				spawn("/bin/sh", ["-c", WAIT_THEN_EXEC, "zinc-relaunch", String(pid), o.appimage], {
					env: relaunchEnv(o.env ?? process.env),
				});
		},
	};
}

// ------------------------------------------------------------------------------------------------------------ macOS: Zinc.app

/**
 * The helper that swaps the bundle once Zinc has quit. Arguments: <pid of Zinc> <1 = start it again>. If the new bundle cannot be moved
 * in, the old one goes back. Either way, with relaunch, the app at `app` is started (the new one, or the old one after a failure).
 */
export function macSwapScript(o: { app: string; fresh: string; stage: string; log: string; open?: string }): string {
	return [
		"#!/bin/sh",
		"# Zinc update helper, written by Zinc (core/src/update/replace.ts): wait for Zinc to quit, swap the app bundle, start it again if asked.",
		`APP=${shQuote(o.app)}`,
		`NEW=${shQuote(o.fresh)}`,
		`STAGE=${shQuote(o.stage)}`,
		`OPEN=${shQuote(o.open ?? "/usr/bin/open")}`,
		'PID="$1"',
		'RELAUNCH="$2"',
		`exec >>${shQuote(o.log)} 2>&1`,
		'finish() { if [ "$RELAUNCH" = 1 ]; then "$OPEN" "$APP"; fi; exit "$1"; }',
		'echo "$(date) zinc update: waiting for pid $PID to quit"',
		"i=0",
		'while kill -0 "$PID" 2>/dev/null; do i=$((i+1)); if [ "$i" -gt 600 ]; then echo "Zinc did not quit within 2 minutes; not updating"; exit 1; fi; sleep 0.2; done',
		'if [ ! -d "$NEW" ]; then echo "no new app at $NEW"; finish 1; fi',
		'rm -rf "$STAGE/previous.app"',
		'if ! mv "$APP" "$STAGE/previous.app"; then echo "cannot move $APP aside; not updating"; finish 1; fi',
		'if ! mv "$NEW" "$APP"; then echo "cannot move the new app into place; putting the old one back"; mv "$STAGE/previous.app" "$APP"; finish 1; fi',
		'rm -rf "$STAGE"',
		'echo "$(date) zinc update: replaced $APP"',
		"finish 0",
		"",
	].join("\n");
}

export function macAppReplace(
	o: {
		app: string;
		updatesDir: string;
		platform?: UpdatePlatform;
		open?: string;
		codesign?: string;
		ditto?: string;
		xattr?: string;
	} & ReplaceDeps,
): SelfReplace {
	const parent = dirname(o.app);
	const stage = join(parent, ".zinc-update");
	const script = join(stage, "apply.sh");
	const marker = join(stage, "prepared.sha256");
	const spawn = o.spawn ?? realSpawn;
	const exec = o.exec ?? realExec;
	const canWrite = o.canWrite ?? realCanWrite;
	const codesign = o.codesign ?? "/usr/bin/codesign";
	const fail = (why: string): never => {
		throw new Error(why);
	};
	const signed = async (app: string) => (await exec(codesign, ["--verify", "--deep", "--strict", app])) === 0;

	async function adHocSign(app: string): Promise<void> {
		const macos = join(app, "Contents", "MacOS");
		for (const f of await readdir(macos)) if (f.endsWith(".dylib")) await exec(codesign, ["--force", "--sign", "-", join(macos, f)]);
		if ((await exec(codesign, ["--force", "--sign", "-", app])) !== 0) fail("the new Zinc.app could not be signed");
	}

	return {
		platform: o.platform ?? "darwin-arm64",
		async manualReason() {
			if (o.app.includes("/AppTranslocation/"))
				return "macOS runs this Zinc from a temporary read-only copy, so it cannot replace itself. Move Zinc to Applications and open it from there.";
			if (!(await canWrite(parent)) || !(await canWrite(o.app)))
				return `Zinc cannot write to ${parent}, so it cannot replace Zinc.app. Download the new disk image and drag Zinc to Applications by hand.`;
			return null;
		},
		async prepare(file, m) {
			const done = await readFile(marker, "utf8").catch(() => "");
			if (done.trim() === m.sha256 && existsSync(script)) return; // already unpacked for this download
			await rm(stage, { recursive: true, force: true });
			await mkdir(stage, { recursive: true });
			if ((await exec(o.ditto ?? "/usr/bin/ditto", ["-x", "-k", file, stage])) !== 0)
				fail("the update archive could not be unpacked");
			const apps = (await readdir(stage)).filter((n) => n.endsWith(".app"));
			if (apps.length !== 1) fail("the update archive does not hold exactly one .app");
			const fresh = join(stage, apps[0]!);
			if (!existsSync(join(fresh, "Contents", "MacOS", "zotero-next-gpui")))
				fail(`the update archive's ${apps[0]} has no Contents/MacOS/zotero-next-gpui`);
			await exec(o.xattr ?? "/usr/bin/xattr", ["-dr", "com.apple.quarantine", fresh]); // usually not set (we downloaded it ourselves)
			if (!(await signed(fresh))) {
				await adHocSign(fresh);
				if (!(await signed(fresh))) fail("the new Zinc.app's signature does not verify");
			}
			await mkdir(o.updatesDir, { recursive: true });
			await writeFile(script, macSwapScript({ app: o.app, fresh, stage, log: join(o.updatesDir, "apply.log"), open: o.open }));
			await chmod(script, 0o755);
			await writeFile(marker, `${m.sha256}\n`);
		},
		apply(_file, { relaunch, pid }) {
			if (!existsSync(script)) fail("the update was not prepared");
			spawn("/bin/sh", [script, String(pid), relaunch ? "1" : "0"]);
		},
		async cleanupStale() {
			await rm(stage, { recursive: true, force: true });
		},
	};
}

// ------------------------------------------------------------------------------------------------------------ neither

/** A copy that can only be updated by hand: it still checks, and says why. */
export function manualReplace(platform: UpdatePlatform, reason: string): SelfReplace {
	return {
		platform,
		manualReason: async () => reason,
		prepare: async () => {
			throw new Error(reason);
		},
		apply: () => {
			throw new Error(reason);
		},
	};
}

/**
 * The way this process replaces itself: undefined on Windows (the installer does it) and on platforms without builds; an AppImage
 * replacer when APPIMAGE is set; a Zinc.app replacer when the exe is <something>.app/Contents/MacOS/<exe>; else a manual-only one.
 */
export function detectSelfReplace(o: {
	updatesDir: string;
	platform?: NodeJS.Platform;
	arch?: string;
	env?: Record<string, string | undefined>;
	execPath?: string;
}): SelfReplace | undefined {
	const p = currentPlatform(o.platform, o.arch);
	const env = o.env ?? process.env;
	if (p === "linux-x64") {
		return env.APPIMAGE
			? appImageReplace({ appimage: env.APPIMAGE, env })
			: manualReplace(
					p,
					"This Zinc is not running from an AppImage, so it cannot replace itself. Download the new AppImage from the release page.",
				);
	}
	if (p === "darwin-arm64" || p === "darwin-x64") {
		const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(o.execPath ?? process.execPath);
		return m
			? macAppReplace({ app: m[1]!, updatesDir: o.updatesDir, platform: p })
			: manualReplace(
					p,
					"This Zinc is not running from Zinc.app, so it cannot replace itself. Download the new disk image from the release page.",
				);
	}
	return undefined;
}
