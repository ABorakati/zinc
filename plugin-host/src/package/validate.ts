// Manifest validation: the JSON Schema (plugin-api/manifest.schema.json), then the rules a schema cannot say.
import { isKnownCapability, manifestSchema } from "../permissions/ids";
import { validateSchema } from "./json-schema";
import type { PluginManifest } from "../manifest";

export interface ManifestIssue {
	message: string;
}

/** Returns the problems found; an empty list means the manifest is valid. */
export function validateManifest(data: unknown): string[] {
	const errors = validateSchema(manifestSchema, data);
	if (errors.length) return errors;
	const m = data as PluginManifest & {
		optional_permissions?: { capabilities?: string[]; net?: { hosts?: string[] } };
		permission_reasons?: Record<string, string>;
		locales?: { default: string; available?: string[] };
	};
	const out: string[] = [];
	const caps = m.permissions?.capabilities ?? [];
	const optCaps = m.optional_permissions?.capabilities ?? [];
	for (const id of [...caps, ...optCaps]) if (!isKnownCapability(id)) out.push(`unknown permission id "${id}"`);
	for (const id of caps) if (optCaps.includes(id)) out.push(`permission "${id}" is both required and optional`);
	const hosts = m.permissions?.net?.hosts ?? [];
	for (const h of m.optional_permissions?.net?.hosts ?? []) if (hosts.includes(h)) out.push(`net host "${h}" is both required and optional`);
	for (const key of Object.keys(m.permission_reasons ?? {})) {
		if (key !== "net.hosts" && !isKnownCapability(key)) out.push(`permission_reasons: unknown permission id "${key}"`);
	}
	for (const [k, v] of Object.entries(m.default_prefs ?? {})) {
		if (typeof v === "number" && !Number.isInteger(v)) out.push(`default_prefs/${k}: numbers must be integers`);
	}
	if (m.locales?.available && !m.locales.available.includes(m.locales.default)) out.push(`locales.available does not list the default locale "${m.locales.default}"`);
	return out;
}
