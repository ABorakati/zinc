// Plain-text and icon helpers for registrations (no UI imports).
import type { IconRef, LocalizedString, Opt, ThemedIcon } from "./wit";

/** The text of a localized string. Fluent lookups belong to the `l10n` interface; here the fallback or the id is shown. */
export function lstr(s: Opt<LocalizedString>, fallback = ""): string {
	if (!s) return fallback;
	if (s.tag === "plain") return s.val;
	return s.val.fallback ?? s.val.id ?? fallback;
}

/** A lucide icon name for an icon ref: `builtin` names are lucide kebab-case names; bundled and svg icons are not drawn yet. */
export function iconName(i: Opt<ThemedIcon | IconRef>, fallback = "puzzle"): string {
	if (!i) return fallback;
	const ref: IconRef = "tag" in i ? i : i.light;
	return ref.tag === "builtin" && ref.val ? ref.val : fallback;
}

/** Light/dark pairs: the host tints icons itself, so the light one is used for both. */
export const iconOf = iconName;
