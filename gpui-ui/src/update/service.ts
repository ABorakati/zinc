// Auto-update glue: the core's updater (core/src/update) plus the app's settings, signals, toasts and shutdown hooks.
//
//   startUpdates()   main.tsx calls it once, after the first items are in: starts the 24 h timer (first check ~20 s later), registers the
//                    "install on exit" hooks and removes old installer downloads. No network happens here when "Check automatically" is
//                    off or no feed URL is configured.
//   initUpdates(o)   builds the updater (once); o overrides its dependencies (tests and screenshot scripts use a fake env / key).
//   updateModel()    reactive state for the UI (Settings > System > Updates, toasts).
//   Settings: update.auto (Check automatically, on), update.download (Download automatically, off), update.feedUrl (empty = the build's default).
//   Logging: area "update" (core/src/log.ts).
import { createSignal } from "solid-js";
import { initialModel, type LastCheck, type UpdateModel } from "../../../core/src/update/machine";
import { createRealEnv } from "../../../core/src/update/env";
import type { Manifest } from "../../../core/src/update/manifest";
import { createUpdater, type Updater, type UpdaterDeps } from "../../../core/src/update/updater";
import { onShutdown, servicesWanted, shutdown } from "../services";
import { appVersion, logError, logInfo } from "../shell/errorlog";
import { isBool, persisted } from "../shell/prefs";
import { toast } from "../ui";
import { DEFAULT_FEED_URL, UPDATE_PUBKEY } from "./config";
import { openWhatsNew, showUpdateToast, type UpdateActions } from "./ui";

export const [updateAuto, setUpdateAuto] = persisted<boolean>("update.auto", true, isBool);
export const [updateDownload, setUpdateDownload] = persisted<boolean>("update.download", false, isBool);
export const [updateFeed, setUpdateFeed] = persisted<string>("update.feedUrl", "", (v) => (typeof v === "string" ? v : undefined));

const validLast = (v: unknown): LastCheck | undefined => {
	const o = v as Partial<LastCheck> | null;
	return o &&
		typeof o === "object" &&
		typeof o.at === "string" &&
		(o.result === "up-to-date" || o.result === "available" || o.result === "error")
		? (o as LastCheck)
		: undefined;
};
const [lastCheck, setLastCheck] = persisted<LastCheck | undefined>("update.last", undefined, validLast);

/** The feed in use: the one chosen in Settings, else the build's default (empty until a feed is published). */
export const feedUrl = (): string => updateFeed().trim() || DEFAULT_FEED_URL;
/** This build's version (ZN_VERSION), "dev" for an unstamped source run. */
export const currentVersion = (): string => versionUsed ?? appVersion();
/** True when this build can update at all: it has a public key and a real version number. */
export const updatesPossible = (): boolean => !!keyUsed && currentVersion() !== "dev";

export const [updateModel, setUpdateModel] = createSignal<UpdateModel>(initialModel(lastCheck()));

const originOf = (u: string): string | undefined => {
	try {
		return new URL(u).origin;
	} catch {
		return undefined;
	}
};

let updater: Updater | undefined;
let versionUsed: string | undefined; // initUpdates overrides (tests, screenshots)
let keyUsed = UPDATE_PUBKEY;
let notified = ""; // "<version>:<kind>" of the last toast, so one version is announced once per run
let lastSaved = "";

const actions: UpdateActions = {
	installNow() {
		const k = updateModel().state.kind;
		toast(k === "available" || k === "downloading" ? "Downloading the update…" : "Installing the update…", {
			id: "update-progress",
			description: "Zinc will close and start again when it is done.",
			durationMs: 8000,
		});
		void updater?.installNow().catch((e) => logError("update", e, "install now"));
	},
	installOnExit() {
		void updater
			?.setInstallOnExit(true)
			.then((m) => {
				if (m.installOnExit) toast.success("The update will be installed when you quit Zinc", { id: "update-progress" });
			})
			.catch((e) => logError("update", e, "install on exit"));
	},
};
export { actions as updateActions };

function onChange(m: UpdateModel): void {
	setUpdateModel(m);
	if (m.lastCheck) {
		const k = JSON.stringify(m.lastCheck);
		if (k !== lastSaved) {
			lastSaved = k;
			setLastCheck(m.lastCheck);
		}
	}
	const s = m.state;
	if (s.kind === "available" && !s.manualOnly && !updateDownload()) announce(s.manifest, false);
	else if (s.kind === "ready") announce(s.manifest, true);
	else if (s.kind === "error" && s.phase !== "check")
		toast.error(s.phase === "install" ? "Could not install the update" : "Could not download the update", {
			id: "update-error",
			description: s.message,
			durationMs: 10000,
		});
}

function announce(m: Manifest, ready: boolean): void {
	const key = `${m.version}:${ready ? "ready" : "available"}`;
	if (notified === key || (!ready && notified === `${m.version}:ready`)) return;
	notified = key;
	showUpdateToast(m, actions, { ready });
}

/** Build the updater (once). `o` overrides its dependencies. */
export function initUpdates(o: Partial<UpdaterDeps> = {}): Updater {
	if (updater) return updater;
	versionUsed = o.currentVersion;
	keyUsed = o.publicKey ?? UPDATE_PUBKEY;
	updater = createUpdater({
		currentVersion: currentVersion(),
		publicKey: UPDATE_PUBKEY,
		settings: () => ({ enabled: updateAuto(), autoDownload: updateDownload(), feedUrl: feedUrl() }),
		env: createRealEnv({ token: process.env.ZN_UPDATE_TOKEN, tokenOrigin: () => originOf(feedUrl()) }),
		prepareExit: () => shutdown(), // services stop, pending writes flush, the database closes
		lastCheck: lastCheck(),
		...o,
		onChange: (m) => {
			onChange(m);
			o.onChange?.(m);
		},
	});
	setUpdateModel(updater.model());
	return updater;
}

/** Settings > Updates > Check now (works even with "Check automatically" off; still needs a feed URL). */
export function checkNow(): void {
	void initUpdates()
		.check({ manual: true })
		.catch((e) => logError("update", e, "check now"));
}

/** Show the release notes of the update found (Settings > Updates > What's new). */
export function showWhatsNew(): void {
	const s = updateModel().state;
	if ("manifest" in s && s.manifest) openWhatsNew(s.manifest, actions, { manualOnly: s.kind === "available" && s.manualOnly });
}

let started = false;
/** Called once from main.tsx, after the first items. Cheap and non-blocking; does no network itself. */
export function startUpdates(): void {
	if (started) return;
	started = true;
	try {
		const u = initUpdates();
		process.on("exit", (code) => u.onExit(code)); // the sync half of "install on exit"
		if (servicesWanted()) onShutdown("update install-on-exit", () => u.prepareForExit()); // the async half: re-verify before exit
		u.start();
		void u.cleanup();
		logInfo("update", "updater started", {
			version: currentVersion(),
			auto: updateAuto(),
			feed: feedUrl() ? "configured" : "none",
			key: UPDATE_PUBKEY ? "embedded" : "none",
		});
	} catch (e) {
		logError("update", e, "start");
	}
}
