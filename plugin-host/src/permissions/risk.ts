// Risk tiers and the permission list shown to the user (lifecycle.md 2.4): which ids a manifest declares, grouped by risk, with the
// plugin's own reasons. Net hosts are listed as "net.hosts:<entry>".
import type { PluginManifest } from "../manifest";
import { entryIsPrivate, isPrivateHost, parseHostEntry, type ParsedHostEntry } from "../imports/data/nethosts";
import { capabilityTier, type RiskTier } from "./ids";

export type { RiskTier, ParsedHostEntry };
// the entry parser and the private-address classifier are shared with `net` and `translate.web`: see imports/data/nethosts.ts
export { isPrivateHost, parseHostEntry };

/** high for "*", for loopback or private hosts, and for wildcards on a private or number-like suffix (they grant nothing); medium for named public hosts. */
export function netHostTier(entry: string): RiskTier {
	const p = parseHostEntry(entry);
	return p.any || entryIsPrivate(p) ? "high" : "medium";
}

export const NET_PREFIX = "net.hosts:";

/** Tier of a permission id as it appears in prompts and grants: a capability id or "net.hosts:<entry>". */
export function permissionTier(id: string): RiskTier | undefined {
	if (id.startsWith(NET_PREFIX)) {
		try {
			return netHostTier(id.slice(NET_PREFIX.length));
		} catch {
			return undefined;
		}
	}
	return capabilityTier(id);
}

export interface DeclaredPermissions {
	/** Required capability ids. */
	capabilities: string[];
	/** Required net host entries. */
	netHosts: string[];
	/** Optional (asked for later with `permissions.request`). */
	optionalCapabilities: string[];
	optionalNetHosts: string[];
	shellSchemes: string[];
}

export function declaredPermissions(m: PluginManifest): DeclaredPermissions {
	const opt = (m as { optional_permissions?: { capabilities?: string[]; net?: { hosts?: string[] } } }).optional_permissions;
	const shell = (m.permissions as { shell?: { schemes?: string[] } } | undefined)?.shell;
	return {
		capabilities: [...(m.permissions?.capabilities ?? [])],
		netHosts: [...(m.permissions?.net?.hosts ?? [])],
		optionalCapabilities: [...(opt?.capabilities ?? [])],
		optionalNetHosts: [...(opt?.net?.hosts ?? [])],
		shellSchemes: [...(shell?.schemes ?? [])],
	};
}

/** All required permission ids of a manifest, capabilities then hosts as "net.hosts:<entry>". */
export function requiredIds(d: DeclaredPermissions): string[] {
	return [...d.capabilities, ...d.netHosts.map((h) => NET_PREFIX + h)];
}

export function optionalIds(d: DeclaredPermissions): string[] {
	return [...d.optionalCapabilities, ...d.optionalNetHosts.map((h) => NET_PREFIX + h)];
}

export interface PromptItem {
	id: string;
	tier: RiskTier;
	/** The plugin's reason: manifest `permission_reasons[id]` (for hosts, `["net.hosts"]`). A Fluent id when it has no space. */
	reason?: string;
	optional: boolean;
}

export interface PromptGroup {
	tier: RiskTier;
	items: PromptItem[];
}

/**
 * What the install prompt shows: required and optional permissions grouped by tier (low first, high last). Low ones are granted
 * together, medium ones are separate checkboxes, high ones are off until ticked (lifecycle.md 2.4); the UI decides how to draw that.
 */
export function describePermissions(m: PluginManifest, only?: string[]): PromptGroup[] {
	const d = declaredPermissions(m);
	const reasons = ((m as { permission_reasons?: Record<string, string> }).permission_reasons ?? {}) as Record<string, string>;
	const items: PromptItem[] = [];
	const add = (id: string, optional: boolean) => {
		if (only && !only.includes(id)) return;
		const tier = permissionTier(id) ?? "high";
		items.push({ id, tier, optional, reason: reasons[id] ?? (id.startsWith(NET_PREFIX) ? reasons["net.hosts"] : undefined) });
	};
	for (const id of requiredIds(d)) add(id, false);
	for (const id of optionalIds(d)) add(id, true);
	return (["low", "medium", "high"] as const).map((tier) => ({ tier, items: items.filter((i) => i.tier === tier) })).filter((g) => g.items.length);
}
