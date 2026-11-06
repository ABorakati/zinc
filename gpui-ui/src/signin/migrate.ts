// One-time copy of the old Electrobun app's institution sign-in profile into this app's sign-in profile, so the user does not have to
// sign in again. The old profile is a Chromium user data folder (...\dev.zotero-next.app\stable\WebView2\Partitions\institution\EBWebView);
// its cookies are encrypted with a key in its "Local State" file that is protected by the user's Windows (DPAPI) login, so the same Windows
// user can read the copy. Rules:
//   - only when the new profile does not exist yet (never overwrites a sign-in made here);
//   - the old folder is only READ (and never deleted): uninstalling the old app removes it;
//   - the copy goes to a sibling folder and is renamed into place when complete, so a half copy is never mistaken for a profile;
//   - nothing is copied when the disk is nearly full.
// Cookie values never pass through this code.
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { OLD_PARTITION, signinProfileDir } from "./paths";

export type MigrateStatus = "copied" | "exists" | "no-source" | "no-space" | "failed";
export interface MigrateResult {
	status: MigrateStatus;
	reason?: string;
}

/** Free bytes on the volume that holds `path` (the nearest existing parent), or null when unknown. */
function freeBytes(path: string): number | null {
	let p = path;
	while (p && !existsSync(p)) {
		const up = dirname(p);
		if (up === p) break;
		p = up;
	}
	try {
		const s = statfsSync(p);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

export function migrateOldProfile(o: { from?: string; to?: string; minFreeBytes?: number } = {}): MigrateResult {
	const from = o.from ?? OLD_PARTITION();
	const to = o.to ?? signinProfileDir();
	if (existsSync(to)) return { status: "exists" };
	if (!existsSync(from)) return { status: "no-source" };
	const free = freeBytes(to);
	if (free !== null && free < (o.minFreeBytes ?? 15 * 1024 ** 3)) return { status: "no-space", reason: "less than 15 GB free" };
	const tmp = `${to}.migrating`;
	try {
		rmSync(tmp, { recursive: true, force: true }); // a copy that an earlier run left unfinished (our own folder)
		mkdirSync(dirname(to), { recursive: true });
		cpSync(from, tmp, { recursive: true, errorOnExist: false, force: true });
		renameSync(tmp, to);
		return { status: "copied" };
	} catch (e) {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* left for the next start */
		}
		return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
	}
}
