// Permission ids and risk tiers, read from plugin-api/manifest.schema.json (`$defs.capability.x-risk`), so the schema stays the one
// list. `net.hosts` is not an id: hosts are listed under permissions.net.hosts.
import schema from "../../../plugin-api/manifest.schema.json";

export type RiskTier = "none" | "low" | "medium" | "high";

const xRisk = (schema as any).$defs.capability["x-risk"] as Record<"low" | "medium" | "high", string[]>;

const tiers = new Map<string, RiskTier>();
for (const tier of ["low", "medium", "high"] as const) for (const id of xRisk[tier]) tiers.set(id, tier);

/** Every capability id the host knows. A manifest that lists any other id is rejected at install. */
export const KNOWN_CAPABILITIES: readonly string[] = [...tiers.keys()];

export const isKnownCapability = (id: string): boolean => tiers.has(id);

/** The tier of a capability id; undefined for an unknown id. */
export const capabilityTier = (id: string): RiskTier | undefined => tiers.get(id);

export const manifestSchema = schema as unknown;
