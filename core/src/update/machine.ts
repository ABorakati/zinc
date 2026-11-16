// The updater's state machine: a pure reducer, no I/O. updater.ts drives it; the UI only reads the model.
//
//   idle / up-to-date --check--> checking --checked(null)--> up-to-date
//                                         --checked(m)----> available --download--> downloading --downloaded--> ready --install--> installing
//                                         --check-failed--> error                    --download-failed--> error                  --install-failed--> error
//   An event that does not fit the current state is ignored (the same model comes back), so a late "progress" or a double click is harmless.
//   "install on exit" is a flag beside the state: it is armed while an update is available / downloading / ready and honoured at a normal quit.
import type { Manifest } from "./manifest";
import { isNewer } from "./version";

export type UpdateState =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "up-to-date" }
	/** `manualOnly`: the installed version is older than the manifest's minVersion, so it cannot update in place. */
	| { kind: "available"; manifest: Manifest; manualOnly?: boolean }
	| { kind: "downloading"; manifest: Manifest; received: number; total: number }
	| { kind: "ready"; manifest: Manifest; file: string }
	| { kind: "installing"; manifest: Manifest; file: string }
	| { kind: "error"; phase: "check" | "download" | "install"; message: string; code?: string; manifest?: Manifest };

export interface LastCheck {
	/** ISO time of the check. */
	at: string;
	result: "up-to-date" | "available" | "error";
	version?: string;
	message?: string;
}

export interface UpdateModel {
	state: UpdateState;
	installOnExit: boolean;
	lastCheck?: LastCheck;
}

export type UpdateEvent =
	| { t: "check" }
	| { t: "checked"; at: string; manifest: Manifest | null; manualOnly?: boolean }
	| { t: "check-failed"; at: string; message: string; code?: string }
	| { t: "download" }
	| { t: "progress"; received: number; total: number }
	| { t: "downloaded"; file: string }
	| { t: "download-failed"; message: string; code?: string }
	| { t: "install" }
	| { t: "install-failed"; message: string; code?: string }
	| { t: "install-on-exit"; value: boolean }
	| { t: "dismiss" };

export const initialModel = (lastCheck?: LastCheck): UpdateModel => ({
	state: { kind: "idle" },
	installOnExit: false,
	...(lastCheck ? { lastCheck } : {}),
});

const manifestOf = (s: UpdateState): Manifest | undefined => ("manifest" in s ? s.manifest : undefined);

export function reduce(m: UpdateModel, e: UpdateEvent): UpdateModel {
	const s = m.state;
	const set = (state: UpdateState, extra: Partial<UpdateModel> = {}): UpdateModel => ({ ...m, ...extra, state });
	switch (e.t) {
		case "check":
			return s.kind === "idle" || s.kind === "up-to-date" || s.kind === "available" || s.kind === "error"
				? set({ kind: "checking" })
				: m;
		case "checked":
			if (s.kind !== "checking") return m;
			return e.manifest
				? set(
						{ kind: "available", manifest: e.manifest, ...(e.manualOnly ? { manualOnly: true } : {}) },
						{ lastCheck: { at: e.at, result: "available", version: e.manifest.version } },
					)
				: set({ kind: "up-to-date" }, { lastCheck: { at: e.at, result: "up-to-date" }, installOnExit: false });
		case "check-failed":
			return s.kind === "checking"
				? set(
						{ kind: "error", phase: "check", message: e.message, code: e.code },
						{ lastCheck: { at: e.at, result: "error", message: e.message } },
					)
				: m;
		case "download":
			if (s.kind === "available" && !s.manualOnly)
				return set({ kind: "downloading", manifest: s.manifest, received: 0, total: s.manifest.size });
			if (s.kind === "error" && s.phase !== "check" && s.manifest)
				return set({ kind: "downloading", manifest: s.manifest, received: 0, total: s.manifest.size });
			return m;
		case "progress":
			return s.kind === "downloading" ? set({ ...s, received: e.received, total: e.total || s.total }) : m;
		case "downloaded":
			return s.kind === "downloading" ? set({ kind: "ready", manifest: s.manifest, file: e.file }) : m;
		case "download-failed":
			return s.kind === "downloading"
				? set({ kind: "error", phase: "download", message: e.message, code: e.code, manifest: s.manifest })
				: m;
		case "install":
			return s.kind === "ready" ? set({ kind: "installing", manifest: s.manifest, file: s.file }) : m;
		case "install-failed":
			return s.kind === "installing"
				? set({ kind: "error", phase: "install", message: e.message, code: e.code, manifest: s.manifest }, { installOnExit: false })
				: m;
		case "install-on-exit":
			if (!e.value) return m.installOnExit ? { ...m, installOnExit: false } : m;
			return s.kind === "available" || s.kind === "downloading" || s.kind === "ready" ? { ...m, installOnExit: true } : m;
		case "dismiss": {
			if (s.kind !== "error") return m;
			const mf = manifestOf(s);
			return set(mf && s.phase !== "check" ? { kind: "available", manifest: mf } : { kind: "idle" });
		}
	}
}

// ------------------------------------------------------------------------------------------------------------ downloaded installers

/**
 * File name of the installer download for a manifest: zotero-next-<version>-setup.<ext> (characters outside [0-9A-Za-z.+-] become "_").
 * <ext> is the extension of the manifest's url: exe (the real installer), or cmd / bat (the stub installers of the tests); anything else is exe.
 */
export function installerName(m: { version: string; url: string }): string {
	let ext = "exe";
	try {
		const e = /\.(exe|cmd|bat)$/i.exec(new URL(m.url).pathname);
		if (e) ext = e[1]!.toLowerCase();
	} catch {
		/* exe */
	}
	return `zotero-next-${m.version.replace(/[^0-9A-Za-z.+-]/g, "_")}-setup.${ext}`;
}

const OURS = /^zotero-next-.+-setup\.(exe|cmd|bat)(\.part)?$/i;

const NAME_VERSION = /^zotero-next-(.+)-setup.(?:exe|cmd|bat)(?:.part)?$/i;

/**
 * Which files in the updates folder to delete: every installer download (and partial one) of ours except those in `keep`. Nothing else
 * is ever touched. With nothing to keep AND `current` given (start-up, or "up to date"), only downloads that are not newer than the
 * running version go: a half-downloaded newer installer survives a restart so it can be resumed.
 */
export function planCleanup(files: string[], keep: string[], current?: string): string[] {
	const k = new Set(keep.flatMap((n) => [n.toLowerCase(), `${n.toLowerCase()}.part`]));
	return files.filter((f) => {
		if (!OURS.test(f) || k.has(f.toLowerCase())) return false;
		if (keep.length || !current) return true;
		const v = NAME_VERSION.exec(f)?.[1];
		return !v || !isNewer(v, current);
	});
}
