// What the user granted each plugin, persisted in <root>/grants.json, and the pure functions that turn it into the supervisor's
// `Grants`. The supervisor takes `grantsFor(manifest)` (synchronous), so the store is in memory with write-through.
import type { Grants, PluginManifest } from "../manifest";
import { readJson, writeJsonAtomic } from "../package/json-file";
import { declaredPermissions, NET_PREFIX, optionalIds, requiredIds } from "./risk";

export interface GrantRecord {
	/** Granted ids: capability ids and "net.hosts:<entry>" (required and optional alike). */
	granted: string[];
	/** The ids the user has already been shown (declared required + optional). An update that declares others needs approval. */
	seen: string[];
}

export type PermissionState = "granted" | "denied" | "optional" | "undeclared";

export class GrantStore {
	private data: Record<string, GrantRecord>;

	constructor(private file: string) {
		this.data = readJson<Record<string, GrantRecord>>(file, {});
	}

	private save() {
		writeJsonAtomic(this.file, this.data);
	}

	has(id: string): boolean {
		return id in this.data;
	}

	get(id: string): GrantRecord | undefined {
		return this.data[id];
	}

	set(id: string, rec: GrantRecord) {
		this.data[id] = { granted: [...new Set(rec.granted)], seen: [...new Set(rec.seen)] };
		this.save();
	}

	grant(id: string, perm: string) {
		const r = this.data[id];
		if (!r || r.granted.includes(perm)) return;
		r.granted.push(perm);
		this.save();
	}

	revoke(id: string, perm: string) {
		const r = this.data[id];
		if (!r) return;
		r.granted = r.granted.filter((p) => p !== perm);
		this.save();
	}

	remove(id: string) {
		if (!(id in this.data)) return;
		delete this.data[id];
		this.save();
	}

	/**
	 * The supervisor's grants for a manifest: granted ids that the manifest still declares (a permission the plugin dropped in an
	 * update is gone with it). A plugin the store has no record of gets nothing.
	 */
	grantsFor = (m: PluginManifest): Grants => {
		const rec = this.data[m.id];
		if (!rec) return { capabilities: [], netHosts: [] };
		const d = declaredPermissions(m);
		const allowed = new Set([...requiredIds(d), ...optionalIds(d)]);
		const ok = rec.granted.filter((p) => allowed.has(p));
		return {
			capabilities: ok.filter((p) => !p.startsWith(NET_PREFIX)),
			netHosts: ok.filter((p) => p.startsWith(NET_PREFIX)).map((p) => p.slice(NET_PREFIX.length)),
		};
	};
}

/** `permissions.check` for one id (see lifecycle.wit `permission-state`). Hosts are "net.hosts:<entry>"; plain "net.hosts" means any host. */
export function permissionState(m: PluginManifest, grants: Readonly<Grants>, permission: string): PermissionState {
	const d = declaredPermissions(m);
	if (permission === "net.hosts") {
		if (grants.netHosts.length) return "granted";
		if (d.netHosts.length) return "denied";
		return d.optionalNetHosts.length ? "optional" : "undeclared";
	}
	if (permission.startsWith(NET_PREFIX)) {
		const entry = permission.slice(NET_PREFIX.length);
		if (grants.netHosts.includes(entry)) return "granted";
		if (d.netHosts.includes(entry)) return "denied";
		return d.optionalNetHosts.includes(entry) ? "optional" : "undeclared";
	}
	if (grants.capabilities.includes(permission)) return "granted";
	if (d.capabilities.includes(permission)) return "denied";
	return d.optionalCapabilities.includes(permission) ? "optional" : "undeclared";
}

/** `permissions.list-permissions`: everything declared (required and optional), with its state. */
export function listPermissions(m: PluginManifest, grants: Readonly<Grants>): Array<[string, PermissionState]> {
	const d = declaredPermissions(m);
	const ids = [...requiredIds(d), ...optionalIds(d)];
	return ids.map((id) => [id, permissionState(m, grants, id)]);
}
