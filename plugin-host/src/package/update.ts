// Update checks. The update manifest has the shape of Zotero's updates.json with an `applications.zinc` key:
//   { "addons": { "<id>": { "updates": [ { "version", "update_link", "update_hash": "sha256:...", "notes_url"?, "applications": { "zinc": { "strict_min_version" } } } ] } } }
// `update_url` and `update_link` must be https, and `update_hash` is required (lifecycle.md 2.3).
import type { PluginManifest } from "../manifest";
import { semverCompare } from "./semver";
import { sha256Hex } from "./hash";

export interface UpdateCandidate {
	version: string;
	link: string;
	/** Lower-case hex SHA-256 of the package. */
	sha256: string;
	notesUrl?: string;
}

export interface UpdateOptions {
	zincVersion: string;
	fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
	timeoutMs?: number;
}

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export class UpdateError extends Error {}

/** The newest update that is above the installed version and runs on this Zinc, or undefined. */
export async function checkForUpdate(m: PluginManifest, o: UpdateOptions): Promise<UpdateCandidate | undefined> {
	const url = (m as { update_url?: string }).update_url;
	if (!url) return undefined;
	if (!url.startsWith("https://")) throw new UpdateError("update_url must be https");
	const doFetch = o.fetch ?? (fetch as unknown as NonNullable<UpdateOptions["fetch"]>);
	const res = await doFetch(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
	if (!res.ok) throw new UpdateError(`update manifest: HTTP ${res.status}`);
	const body = (await res.json()) as { addons?: Record<string, { updates?: Array<Record<string, any>> }> };
	const updates = body?.addons?.[m.id]?.updates;
	if (!Array.isArray(updates)) return undefined;
	let best: UpdateCandidate | undefined;
	for (const u of updates) {
		if (typeof u?.version !== "string" || typeof u.update_link !== "string" || typeof u.update_hash !== "string") continue;
		if (!u.update_link.startsWith("https://")) continue;
		const hash = /^sha256:([0-9a-fA-F]{64})$/.exec(u.update_hash);
		if (!hash) continue;
		const min = u.applications?.zinc?.strict_min_version;
		if (typeof min === "string" && semverCompare(o.zincVersion, min) < 0) continue;
		if (semverCompare(u.version, m.version) <= 0) continue;
		if (best && semverCompare(u.version, best.version) <= 0) continue;
		best = { version: u.version, link: u.update_link, sha256: hash[1].toLowerCase(), notesUrl: typeof u.notes_url === "string" ? u.notes_url : undefined };
	}
	return best;
}

/** Downloads the package of an update and checks its hash. Never installs it. */
export async function downloadUpdate(c: UpdateCandidate, o: UpdateOptions): Promise<Uint8Array> {
	if (!c.link.startsWith("https://")) throw new UpdateError("update_link must be https");
	const doFetch = o.fetch ?? (fetch as unknown as NonNullable<UpdateOptions["fetch"]>);
	const res = await doFetch(c.link, { signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) });
	if (!res.ok) throw new UpdateError(`download: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length > MAX_PACKAGE_BYTES) throw new UpdateError("update package is too large");
	if (sha256Hex(bytes) !== c.sha256) throw new UpdateError("update package does not match update_hash");
	return bytes;
}
