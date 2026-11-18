// Plugin strings (lifecycle.wit, interface l10n). A plugin ships Fluent files at `<locales.dir>/<tag>/*.ftl` (default dir "locale");
// one bundle per plugin and locale, loaded from the plugin's folder when first needed. The locale for the UI is picked with the chain
// of lifecycle.md 2.6: the exact tag, another tag with the same language, the manifest's default locale, the first locale listed.
// A message missing in the picked locale is looked up in the next ones of that chain, then `fallback`, then the id itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../manifest";
import { formatMessage, parseFluent, type FluentArg, type Resource } from "./fluent";

export interface L10nRef {
	id: string;
	args: Array<{ name: string; value: { tag: string; val: unknown } }>;
	fallback?: string;
}

export type LocalizedString = { tag: "plain"; val: string } | { tag: "localized"; val: L10nRef };

interface Bundle {
	tag: string;
	messages: Resource["messages"];
	terms: Resource["terms"];
}

interface PluginBundles {
	dir: string;
	/** All locales, in the order the manifest lists them. */
	all: Bundle[];
}

export interface L10nOptions {
	/** The UI locale (BCP 47). Called at every format, so a locale change is picked up at once. */
	locale: () => string;
	timeZone?: () => string | undefined;
	/** Plugin folder (where `locale/` is). */
	dirOf: (plugin: string) => string | undefined;
	manifestOf: (plugin: string) => PluginManifest | undefined;
	warn?: (plugin: string, message: string) => void;
}

export const lang = (tag: string) => tag.split(/[-_]/)[0].toLowerCase();

/** The locale chain for a requested tag: exact, same language, default, then the rest in listed order. */
export function localeChain(available: string[], requested: string, defaultLocale?: string): string[] {
	const out: string[] = [];
	const push = (t: string | undefined) => {
		if (t && !out.includes(t)) out.push(t);
	};
	push(available.find((t) => t.toLowerCase() === requested.toLowerCase()));
	for (const t of available) if (lang(t) === lang(requested)) push(t);
	push(defaultLocale && available.includes(defaultLocale) ? defaultLocale : undefined);
	for (const t of available) push(t);
	return out;
}

export class L10nService {
	private cache = new Map<string, PluginBundles>();
	private warned = new Set<string>();

	constructor(private o: L10nOptions) {}

	/** Forget a plugin's bundles (after an update or uninstall). */
	invalidate(plugin: string) {
		this.cache.delete(plugin);
		for (const w of [...this.warned]) if (w.startsWith(plugin + "\0")) this.warned.delete(w);
	}

	/** Raw Fluent sources (`{ defaultLocale, bundles }`) for pushing to `zhw`. */
	rawBundles(
		plugin: string,
		dirOverride?: string,
		manifestOverride?: PluginManifest,
	): { defaultLocale?: string; bundles: Array<{ tag: string; ftl: string }> } | undefined {
		const dir = dirOverride ?? this.o.dirOf(plugin);
		const m = (manifestOverride ?? this.o.manifestOf(plugin)) as
			| (PluginManifest & { locales?: { default: string; available?: string[]; dir?: string } })
			| undefined;
		if (!dir) return undefined;
		const base = join(dir, m?.locales?.dir ?? "locale");
		let tags = m?.locales?.available;
		if (!tags) {
			try {
				tags = readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory());
			} catch {
				tags = [];
			}
		}
		const bundles: Array<{ tag: string; ftl: string }> = [];
		for (const tag of tags) {
			const d = join(base, tag);
			if (!existsSync(d)) continue;
			const parts: string[] = [];
			for (const f of readdirSync(d).filter((n) => n.endsWith(".ftl")).sort()) {
				parts.push(readFileSync(join(d, f), "utf8"));
			}
			bundles.push({ tag, ftl: parts.join("\n") });
		}
		return { defaultLocale: m?.locales?.default, bundles };
	}

	private bundles(plugin: string): PluginBundles | undefined {
		const hit = this.cache.get(plugin);
		if (hit) return hit;
		const dir = this.o.dirOf(plugin);
		const m = this.o.manifestOf(plugin) as (PluginManifest & { locales?: { default: string; available?: string[]; dir?: string } }) | undefined;
		if (!dir) return undefined;
		const base = join(dir, m?.locales?.dir ?? "locale");
		let tags = m?.locales?.available;
		if (!tags) {
			try {
				tags = readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory());
			} catch {
				tags = [];
			}
		}
		const all: Bundle[] = [];
		for (const tag of tags) {
			const d = join(base, tag);
			if (!existsSync(d)) continue;
			const messages: Bundle["messages"] = new Map();
			const terms: Bundle["terms"] = new Map();
			for (const f of readdirSync(d).filter((n) => n.endsWith(".ftl")).sort()) {
				const r = parseFluent(readFileSync(join(d, f), "utf8"));
				for (const [k, v] of r.messages) messages.set(k, v);
				for (const [k, v] of r.terms) terms.set(k, v);
				for (const err of r.errors) this.o.warn?.(plugin, `${tag}/${f}: ${err}`);
			}
			all.push({ tag, messages, terms });
		}
		const out = { dir, all };
		this.cache.set(plugin, out);
		return out;
	}

	/** Locales the plugin ships (as listed in the manifest, else the folders found). */
	pluginLocales(plugin: string): string[] {
		return this.bundles(plugin)?.all.map((b) => b.tag) ?? [];
	}

	/** True if any locale of the plugin has the message (`id` may be `message.attribute`). */
	hasMessage(plugin: string, id: string): boolean {
		const dot = id.indexOf(".");
		const base = dot < 0 ? id : id.slice(0, dot);
		const attr = dot < 0 ? undefined : id.slice(dot + 1);
		return (this.bundles(plugin)?.all ?? []).some((b) => {
			const m = b.messages.get(base);
			return !!m && (attr ? attr in m.attrs : !!m.value);
		});
	}

	private args(ref: L10nRef): Record<string, FluentArg> {
		const out: Record<string, FluentArg> = {};
		for (const a of ref.args ?? []) {
			const v = a.value;
			if (v.tag === "text") out[a.name] = String(v.val);
			else if (v.tag === "integer" || v.tag === "number") out[a.name] = Number(v.val);
			else if (v.tag === "date") out[a.name] = new Date(Number(v.val));
		}
		return out;
	}

	/** One message as a string: the picked locale, then the rest of the chain, then `fallback`, then the id. */
	format(plugin: string, ref: L10nRef): string {
		const b = this.bundles(plugin);
		const locale = this.o.locale();
		const m = this.o.manifestOf(plugin) as (PluginManifest & { locales?: { default: string } }) | undefined;
		if (b) {
			const chain = localeChain(b.all.map((x) => x.tag), locale, m?.locales?.default);
			const args = this.args(ref);
			for (const tag of chain) {
				const bundle = b.all.find((x) => x.tag === tag)!;
				const text = formatMessage(
					{ locale: tag, lookup: (id) => bundle.messages.get(id), term: (id) => bundle.terms.get(id), onError: (e) => this.warnOnce(plugin, `${tag}: ${ref.id}: ${e}`) },
					ref.id,
					args,
				);
				if (text !== undefined) return text;
			}
		}
		this.warnOnce(plugin, `missing message "${ref.id}"`);
		return ref.fallback ?? ref.id;
	}

	private warnOnce(plugin: string, message: string) {
		const key = `${plugin}\0${message}`;
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.o.warn?.(plugin, message);
	}

	formatMany(plugin: string, refs: L10nRef[]): string[] {
		return refs.map((r) => this.format(plugin, r));
	}

	/** For the UI and extend areas: a `localized-string` (plain or localized) as text in the current UI locale. */
	resolve(plugin: string, s: LocalizedString): string {
		return s.tag === "plain" ? s.val : this.format(plugin, s.val);
	}

	locale(): string {
		return this.o.locale();
	}

	formatDate(when: bigint | number, style: "short" | "medium" | "long" | "full", withTime: boolean): string {
		const opts: Intl.DateTimeFormatOptions = { dateStyle: style };
		if (withTime) opts.timeStyle = style === "full" ? "long" : style;
		const tz = this.o.timeZone?.();
		if (tz) opts.timeZone = tz;
		return new Intl.DateTimeFormat(this.o.locale(), opts).format(new Date(Number(when)));
	}

	formatNumber(value: number, fractionDigits: number | undefined): string {
		const opts: Intl.NumberFormatOptions = fractionDigits === undefined ? {} : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
		return new Intl.NumberFormat(this.o.locale(), opts).format(value);
	}
}
