// Schema validation for JSON UI trees, patches, row content and styles against `plugin-api/ui-schema/ui-tree.schema.json`.
//
// Two modes:
//   - "full"  (default in tests and debug builds): validates every node, style, binding, draw op and patch op against the
//             JSON Schema (types, enums, patterns, numeric bounds, required fields, additionalProperties / unevaluatedProperties).
//   - "cheap" (release builds): checks only top-level structure; per-node kind and limit checks happen during the single-pass conversion.
import rawSchema from "../../../../plugin-api/ui-schema/ui-tree.schema.json";

export type ValidationMode = "full" | "cheap";

function defaultMode(): ValidationMode {
	const env = typeof process !== "undefined" ? process.env : undefined;
	if (env?.ZN_UI_VALIDATE === "cheap") return "cheap";
	if (env?.ZN_UI_VALIDATE === "full") return "full";
	// The packaged app (the same exe-name test as src/packaged.ts, which is not imported here: importing it resolves the library).
	// Zinc's builds never set NODE_ENV, so that cannot be the signal.
	const exe = typeof process !== "undefined" ? (process.execPath.split(/[\\/]/).pop() ?? "") : "";
	if (/^zotero-next-gpui(-[\w-]+)?(\.exe)?$/i.test(exe)) return "cheap";
	return "full";
}

let currentMode: ValidationMode = defaultMode();

export function getValidationMode(): ValidationMode {
	return currentMode;
}

export function setValidationMode(mode: ValidationMode): void {
	currentMode = mode;
}

type SchemaNode = Record<string, any>;
const defs: Record<string, SchemaNode> = (rawSchema as Record<string, any>).$defs;
const regexCache = new Map<string, RegExp>();
const getRegex = (pat: string): RegExp => {
	let r = regexCache.get(pat);
	if (!r) regexCache.set(pat, (r = new RegExp(pat)));
	return r;
};

// Pre-merge `allOf` on node definitions (`n-*`) so each node kind validates in O(1) without re-evaluating `allOf` per node.
interface CompiledObject {
	required: readonly string[];
	props: Record<string, SchemaNode>;
	allowAdditional: boolean | SchemaNode;
	propNames?: SchemaNode;
}
const compiledNodes = new Map<string, CompiledObject>();
const nodeBase = defs.nodeBase!;
for (const [k, def] of Object.entries(defs)) {
	if (!k.startsWith("n-") || !Array.isArray(def.allOf)) continue;
	const kindName = k.slice(2);
	const extra = def.allOf[1] ?? {};
	const props: Record<string, SchemaNode> = { ...nodeBase.properties, ...(extra.properties ?? {}) };
	const required: string[] = [...(nodeBase.required ?? []), ...(extra.required ?? [])];
	compiledNodes.set(kindName, {
		required,
		props,
		allowAdditional: def.unevaluatedProperties !== false,
	});
}

// Pre-index discriminated `oneOf` tables (`drawOp` and `patchOp` by `op`).
const drawOpByOp = new Map<string, SchemaNode>();
for (const branch of defs.drawOp?.oneOf ?? []) {
	const c = branch.properties?.op?.const;
	if (typeof c === "string") drawOpByOp.set(c, branch);
}
const patchOpByOp = new Map<string, SchemaNode>();
for (const branch of defs.patchOp?.oneOf ?? []) {
	const c = branch.properties?.op?.const;
	if (typeof c === "string") patchOpByOp.set(c, branch);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkType(v: unknown, t: string): boolean {
	switch (t) {
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number" && Number.isFinite(v);
		case "integer":
			return typeof v === "number" && Number.isInteger(v);
		case "boolean":
			return typeof v === "boolean";
		case "null":
			return v === null;
		case "array":
			return Array.isArray(v);
		case "object":
			return isObj(v);
		default:
			return true;
	}
}

function validateSchema(v: unknown, s: SchemaNode, path: string): string | undefined {
	if (s.$ref) {
		const refName = (s.$ref as string).replace("#/$defs/", "");
		if (refName === "node" || refName === "rowContent") return validateNode(v, path);
		if (refName === "drawOp") return validateDiscriminated(v, drawOpByOp, "draw op", path);
		if (refName === "patchOp") return validateDiscriminated(v, patchOpByOp, "patch op", path);
		const target = defs[refName];
		if (!target) return `${path}: unknown schema ref ${s.$ref}`;
		return validateSchema(v, target, path);
	}
	if (s.const !== undefined && v !== s.const) {
		return `${path}: expected ${JSON.stringify(s.const)}, got ${JSON.stringify(v)}`;
	}
	if (s.enum !== undefined && !(s.enum as unknown[]).includes(v)) {
		return `${path}: value ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`;
	}
	if (s.oneOf !== undefined) {
		for (const branch of s.oneOf as SchemaNode[]) {
			if (validateSchema(v, branch, path) === undefined) return undefined;
		}
		return `${path}: invalid value ${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
	}
	if (s.type !== undefined) {
		const ok = Array.isArray(s.type) ? s.type.some((t: string) => checkType(v, t)) : checkType(v, s.type as string);
		if (!ok) return `${path}: expected ${Array.isArray(s.type) ? s.type.join("|") : s.type}`;
	}
	if (typeof v === "string") {
		if (s.pattern !== undefined && !getRegex(s.pattern as string).test(v)) {
			return `${path}: "${v}" does not match ${s.pattern}`;
		}
		if (s.maxLength !== undefined && v.length > s.maxLength) return `${path}: longer than ${s.maxLength} characters`;
		if (s.minLength !== undefined && v.length < s.minLength) return `${path}: shorter than ${s.minLength} characters`;
	} else if (typeof v === "number") {
		if (s.minimum !== undefined && v < s.minimum) return `${path}: ${v} < minimum ${s.minimum}`;
		if (s.maximum !== undefined && v > s.maximum) return `${path}: ${v} > maximum ${s.maximum}`;
		if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) return `${path}: ${v} <= ${s.exclusiveMinimum}`;
	} else if (Array.isArray(v)) {
		if (s.items) {
			for (let i = 0; i < v.length; i++) {
				const err = validateSchema(v[i], s.items as SchemaNode, `${path}[${i}]`);
				if (err) return err;
			}
		}
	} else if (isObj(v)) {
		if (Array.isArray(s.required)) {
			for (const req of s.required as string[]) {
				if (v[req] === undefined) return `${path}: missing required field "${req}"`;
			}
		}
		const props = (s.properties ?? {}) as Record<string, SchemaNode>;
		for (const [k, val] of Object.entries(v)) {
			if (val === undefined) continue;
			if (s.propertyNames) {
				const err = validateSchema(k, s.propertyNames as SchemaNode, `${path}.${k}(key)`);
				if (err) return err;
			}
			const propSchema = props[k];
			if (propSchema) {
				const err = validateSchema(val, propSchema, `${path}.${k}`);
				if (err) return err;
			} else if (s.additionalProperties === false) {
				return `${path}: unknown field "${k}"`;
			} else if (isObj(s.additionalProperties)) {
				const err = validateSchema(val, s.additionalProperties as SchemaNode, `${path}.${k}`);
				if (err) return err;
			}
		}
	}
	return undefined;
}

function validateDiscriminated(v: unknown, table: Map<string, SchemaNode>, label: string, path: string): string | undefined {
	if (!isObj(v) || typeof v.op !== "string") return `${path}: ${label} needs an "op" string`;
	const branch = table.get(v.op);
	if (!branch) return `${path}: unknown ${label} "${v.op}"`;
	return validateSchema(v, branch, `${path}(${v.op})`);
}

function validateNode(v: unknown, path: string): string | undefined {
	if (!isObj(v) || typeof v.type !== "string") return `${path}: a node needs a "type" string`;
	const compiled = compiledNodes.get(v.type);
	if (!compiled) return `${path}: unknown node type "${v.type}"`;
	const nPath = `${path}<${v.type}>`;
	for (const req of compiled.required) {
		if (v[req] === undefined) return `${nPath}: missing required field "${req}"`;
	}
	for (const [k, val] of Object.entries(v)) {
		if (val === undefined) continue;
		const propSchema = compiled.props[k];
		if (!propSchema) {
			if (!compiled.allowAdditional) return `${nPath}: unknown field "${k}"`;
			continue;
		}
		const err = validateSchema(val, propSchema, `${nPath}.${k}`);
		if (err) return err;
	}
	return undefined;
}

export function validateTreeObject(j: unknown, mode: ValidationMode = currentMode): string | undefined {
	if (!isObj(j) || !isObj(j.root)) return "the JSON tree needs a `root` object";
	if (mode === "cheap") return undefined;
	return validateSchema(j, defs.tree!, "tree");
}

export function validatePatchObject(j: unknown, mode: ValidationMode = currentMode): string | undefined {
	if (!isObj(j) || typeof j.baseRev !== "number" || typeof j.rev !== "number" || !Array.isArray(j.ops)) {
		return "the JSON patch needs numeric `baseRev`, `rev`, and an `ops` array";
	}
	if (mode === "cheap") return undefined;
	return validateSchema(j, defs.patchSet!, "patch");
}

export function validateNodeObject(j: unknown, mode: ValidationMode = currentMode): string | undefined {
	if (!isObj(j) || typeof j.type !== "string") return "a node needs a `type`";
	if (mode === "cheap") return undefined;
	return validateNode(j, "node");
}

export function validateStyleObject(j: unknown, mode: ValidationMode = currentMode): string | undefined {
	if (!isObj(j)) return "style must be an object";
	if (mode === "cheap") return undefined;
	return validateSchema(j, defs.style!, "style");
}

export function validateNamedStylesArray(j: unknown, mode: ValidationMode = currentMode): string | undefined {
	if (!Array.isArray(j)) return "named styles must be an array";
	if (mode === "cheap") return undefined;
	return validateSchema(j, defs.namedStyles!, "styles");
}
