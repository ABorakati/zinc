// Zotero.Translate.SandboxManager on node:vm. translation-server evals translator code in the host scope, where it
// could reach require()/process; here the code runs in a vm context whose only globals are the ones Zotero's
// translate framework imports (Zotero, ZU, request helpers) plus a short list of web-platform names translators
// use (URL, XPathResult, DOMParser, ...). No require, process, Bun, fetch or dynamic import() exist inside.
// This is containment against accidents and casual abuse, not a hardened boundary: host objects handed to the
// translator (documents, Zotero.Utilities results) still have host prototypes, so the process-level limits
// (worker, timeout, request cap) are the real backstop.
//
// Bun's vm does not reliably re-declare functions/vars when scripts run repeatedly in one context, and the
// framework reuses one sandbox for many translators during detection, so each eval gets a fresh context built
// from `this.sandbox` and the translator-defined names are copied back to it.
import vm from "node:vm";
import { baseWindow } from "./dom";

let extra: Record<string, unknown> | null = null;

function extraGlobals(): Record<string, unknown> {
	if (extra) return extra;
	const w = baseWindow();
	const quiet = () => {};
	extra = {
		XPathResult: (globalThis as any).XPathResult,
		DOMParser: (globalThis as any).DOMParser,
		XMLSerializer: (globalThis as any).XMLSerializer,
		Node: w.Node,
		NodeFilter: w.NodeFilter,
		Element: w.Element,
		HTMLElement: w.HTMLElement,
		Document: w.Document,
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
		atob,
		btoa,
		setTimeout,
		clearTimeout,
		console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
	};
	return extra;
}

export class SandboxManager {
	sandbox: Record<string, any>;
	private wrap: (fn: (...a: any[]) => any) => (...a: any[]) => any;

	constructor(_location?: unknown) {
		this.sandbox = { Zotero: {} };
		// functions are re-created inside a context so `fn.constructor` is that context's own Function, not the host's
		const ctx = vm.createContext({});
		this.wrap = vm.runInContext("(function (fn) { return function () { return fn.apply(this, arguments); }; })", ctx);
	}

	/** Evaluates code in a fresh context; the names in `functions` (plus any top-level function) land in `this.sandbox`. */
	eval(code: string, functions?: string[], path?: string): void {
		const names = functions ?? [];
		for (const f of names) delete this.sandbox[f];
		const global: Record<string, unknown> = { ...extraGlobals(), ...this.sandbox };
		const ctx = vm.createContext(global, { codeGeneration: { strings: true, wasm: false } });
		vm.runInContext(code, ctx, { filename: path || "translator.js", timeout: 15000 });
		for (const f of names) if (global[f] !== undefined) this.sandbox[f] = global[f];
	}

	/** Imports an object into the sandbox under Zotero (or `attachTo`); methods optionally get `passAsFirstArgument`. */
	importObject(object: any, passAsFirstArgument?: unknown, attachTo?: any): void {
		if (!attachTo) attachTo = this.sandbox.Zotero;
		for (const key in object.__exposedProps__ ? object.__exposedProps__ : object) {
			if ((Function.prototype as any)[key]) continue;
			const value = object[key];
			if (typeof value === "function" || (typeof value === "object" && value !== null)) {
				const fn = value;
				const bound = this.wrap(function (this: unknown, ...args: any[]) {
					return typeof fn === "function" ? fn.apply(object, passAsFirstArgument ? [passAsFirstArgument, ...args] : args) : undefined;
				});
				attachTo[key] = typeof value === "function" ? bound : Object.assign({}, attachTo[key]);
				this.importObject(value, passAsFirstArgument ? passAsFirstArgument : null, attachTo[key]);
			} else {
				attachTo[key] = value;
			}
		}
	}
}
