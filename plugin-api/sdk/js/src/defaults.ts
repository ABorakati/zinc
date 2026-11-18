// Defaults for required record fields, and the u32 workaround.
//
// 1. A QuickJS guest that hands the host a record with a required (non-option) field missing traps with "unreachable" and the
//    call is lost. `fill(key, value)` returns a copy of `value` with every missing required field of that WIT record set to a
//    neutral default (empty string, 0, false, empty list, the first case of an enum, a nested default record) and does the same
//    for the records nested in present fields. Fields typed as variants or tuples have no neutral default and are left alone.
//    The table is generated from the WIT (scripts/gen-types.ts -> src/generated/defaults.ts).
//
// 2. u32 values at or above 2^31 are clamped to 2^31 - 1 when a JS number crosses to the host as a `u32` record field or a
//    return value (measured with componentize-qjs 0.6: 3000000000 arrives as 2147483647). The same value written as the signed
//    32-bit integer with the same bits arrives correctly. `u32(n)` does that conversion; `rgba()` and `themedColor()` use it for
//    the `color` values (`0xRRGGBBAA`, usually above 2^31 because red is the top byte).
import { RECORD_DEFAULTS, VARIANT_CASES } from "./generated/defaults";

/** Convert an unsigned 32-bit number to the signed number with the same bits, which QuickJS lowers to a `u32` without clamping. */
export const u32 = (n: number): number => {
	if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`u32: ${n} is not an unsigned 32-bit integer`);
	return n | 0;
};

/** A `color` value `{ tag: "rgba" }` from 0 to 255 channels (alpha default 255). */
export const rgba = (r: number, g: number, b: number, a = 255) => ({ tag: "rgba" as const, val: u32(((r << 24) | (g << 16) | (b << 8) | a) >>> 0) });

/** A `color` value `{ tag: "rgba" }` from "#rrggbb" or "#rrggbbaa". */
export const hexColor = (hex: string) => ({ tag: "rgba" as const, val: hexU32(hex) });

/** `"#rrggbb"` / `"#rrggbbaa"` as the signed form of `0xRRGGBBAA` (for `u32` fields). */
export const hexU32 = (hex: string): number => u32(parseInt(hex.length === 7 ? hex.slice(1) + "ff" : hex.slice(1), 16) >>> 0);

/** A `color` value `{ tag: "themed" }` with a fixed colour per mode. */
export const themedColor = (light: string, dark: string) => ({ tag: "themed" as const, val: { light: hexU32(light), dark: hexU32(dark) } });

function make(spec: string, depth: number): unknown {
	if (spec === "s") return "";
	if (spec === "n") return 0;
	if (spec === "g") return 0n;
	if (spec === "f") return false;
	if (spec === "u8") return new Uint8Array(0);
	if (spec === "a" || spec.startsWith("a:")) return [];
	if (spec.startsWith("e:")) return spec.slice(2);
	if (spec.startsWith("r:")) return depth < 16 ? fillAt(spec.slice(2), {}, depth + 1) : undefined;
	return undefined;
}

function deep(spec: string, v: unknown, depth: number): unknown {
	if (v === undefined || v === null) return v;
	if (spec.startsWith("v:")) {
		const cs = VARIANT_CASES[spec.slice(2)]?.[(v as { tag?: string }).tag ?? ""];
		return cs && (v as { val?: unknown }).val !== undefined ? { ...(v as object), val: deep(cs, (v as { val: unknown }).val, depth + 1) } : v;
	}
	if (spec.startsWith("r:")) return typeof v === "object" ? fillAt(spec.slice(2), v as Record<string, unknown>, depth + 1) : v;
	if (spec.startsWith("a:") && Array.isArray(v)) return v.map((x) => deep(spec.slice(2), x, depth));
	return v;
}

function fillAt(key: string, value: Record<string, unknown>, depth: number): Record<string, unknown> {
	const d = RECORD_DEFAULTS[key];
	if (!d) throw new Error(`fill: unknown record "${key}" (keys look like "extend/column-registration"-style names: "extend/ColumnRegistration")`);
	const out: Record<string, unknown> = { ...value };
	for (const [field, spec] of Object.entries(d.req)) {
		const cur = out[field];
		if (cur === undefined) {
			const made = make(spec, depth);
			if (made !== undefined) out[field] = made;
		} else out[field] = deep(spec, cur, depth);
	}
	for (const [field, spec] of Object.entries(d.opt)) if (out[field] !== undefined) out[field] = deep(spec, out[field], depth);
	return out;
}

/**
 * Fill the missing required fields of a WIT record. `key` is `<interface>/<TypeName>` as the generated types name it, for
 * example `fill("extend/ColumnRegistration", { dataKey: "x", label })`.
 */
export function fill<T = Record<string, unknown>>(key: string, value: Record<string, unknown>): T {
	return fillAt(key, value, 0) as T;
}

/** The record keys `fill` knows (for tests and tooling). */
export const recordKeys = (): string[] => Object.keys(RECORD_DEFAULTS);

/** Fill a value by spec string (`"r:extend/Cell"`, `"a:r:extend/Cell"`); used by `definePlugin` for callback results. */
export function fillSpec(spec: string, value: unknown): unknown {
	return deep(spec, value, 0);
}
