// A small JSON Schema checker: just the keywords plugin-api/manifest.schema.json uses (draft 2020-12 subset). It exists so the
// installer validates against the real schema file with no extra dependency. Unknown keywords are ignored (`if`, `then`, `else` and
// `contains` are checked).
type S = any;

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

function matchesType(t: string, v: unknown): boolean {
	const actual = typeOf(v);
	return t === actual || (t === "number" && actual === "integer");
}

export function validateSchema(root: S, data: unknown): string[] {
	const errors: string[] = [];

	const resolve = (ref: string): S => {
		if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
		let cur = root;
		for (const part of ref.slice(2).split("/")) cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
		if (!cur) throw new Error(`unresolved $ref ${ref}`);
		return cur;
	};

	const run = (schema: S, v: unknown, path: string, errs: string[]): void => {
		if (schema === true || schema === undefined) return;
		if (schema === false) return void errs.push(`${path}: not allowed`);
		if (schema.$ref) run(resolve(schema.$ref), v, path, errs);
		if ("const" in schema && !deepEqual(schema.const, v)) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
		if (schema.enum && !schema.enum.some((e: unknown) => deepEqual(e, v))) errs.push(`${path}: must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
		if (schema.type) {
			const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
			if (!types.some((t) => matchesType(t, v))) {
				errs.push(`${path}: must be ${types.join(" or ")}`);
				return;
			}
		}
		if (typeof v === "string") {
			if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
			if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
			if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: does not match ${schema.pattern}`);
			if (schema.format === "uri") {
				try {
					new URL(v);
				} catch {
					errs.push(`${path}: not a URI`);
				}
			}
		}
		if (typeof v === "number") {
			if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
			if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
		}
		if (Array.isArray(v)) {
			if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
			if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${path}: items must be unique`);
			if (schema.items) v.forEach((x, i) => run(schema.items, x, `${path}/${i}`, errs));
		}
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const o = v as Record<string, unknown>;
			const keys = Object.keys(o);
			for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${path}: missing "${r}"`);
			if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errs.push(`${path}: more than ${schema.maxProperties} properties`);
			if (schema.propertyNames) for (const k of keys) run(schema.propertyNames, k, `${path}/${k} (name)`, errs);
			for (const k of keys) {
				const sub = schema.properties?.[k];
				if (sub !== undefined) run(sub, o[k], `${path}/${k}`, errs);
				else if (schema.additionalProperties === false) errs.push(`${path}: unknown property "${k}"`);
				else if (schema.additionalProperties && typeof schema.additionalProperties === "object") run(schema.additionalProperties, o[k], `${path}/${k}`, errs);
			}
		}
		if (schema.oneOf) {
			const passing = schema.oneOf.filter((s: S) => {
				const e: string[] = [];
				run(s, v, path, e);
				return e.length === 0;
			}).length;
			if (passing !== 1) errs.push(`${path}: must match exactly one of the allowed forms (matched ${passing})`);
		}
		if (schema.if !== undefined) {
			const e: string[] = [];
			run(schema.if, v, path, e);
			const branch = e.length === 0 ? schema.then : schema.else;
			if (branch !== undefined) run(branch, v, path, errs);
		}
		if (schema.contains !== undefined && Array.isArray(v)) {
			const has = v.some((x) => {
				const e: string[] = [];
				run(schema.contains, x, path, e);
				return e.length === 0;
			});
			if (!has) errs.push(`${path}: must contain ${"const" in schema.contains ? JSON.stringify(schema.contains.const) : "a matching item"}`);
		}
		if (schema.not) {
			const e: string[] = [];
			run(schema.not, v, path, e);
			if (e.length === 0) errs.push(`${path}: value is not allowed`);
		}
	};

	run(root, data, "", errors);
	return errors.map((e) => (e.startsWith(":") ? `(manifest)${e}` : e));
}
