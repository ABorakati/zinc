// `l10n` (lifecycle.wit): the plugin's Fluent strings (package/l10n.ts), dates and numbers in the UI locale. No permission.
// The UI and extend areas resolve `localized-string` values with `getServices().l10n.resolve(pluginId, value)`.
import { defineHandler } from "./registry";
import { getServices } from "../package/services";
import type { L10nRef } from "../package/l10n";

export default defineHandler({
	interface: "zinc:plugin/l10n",
	where: "zinc",
	functions: {
		format: (ctx, ref: L10nRef) => getServices().l10n.format(ctx.pluginId, ref),
		"format-many": (ctx, refs: L10nRef[]) => getServices().l10n.formatMany(ctx.pluginId, refs),
		"has-message": (ctx, id: string) => getServices().l10n.hasMessage(ctx.pluginId, id),
		locale: () => getServices().l10n.locale(),
		"plugin-locales": (ctx) => getServices().l10n.pluginLocales(ctx.pluginId),
		"format-date": (_ctx, when: bigint, style: "short" | "medium" | "long" | "full", withTime: boolean) => getServices().l10n.formatDate(when, style, withTime),
		"format-number": (_ctx, value: number, fractionDigits: number | undefined) => getServices().l10n.formatNumber(value, fractionDigits),
	},
});
