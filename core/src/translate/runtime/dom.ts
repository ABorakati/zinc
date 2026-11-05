// DOM for translators: jsdom (as translation-server does) plus the XPath engine Zotero's translators expect.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
let JSDOMClass: any;
let wgxpath: any;
let serializeNode: any;

function load(): void {
	if (JSDOMClass) return;
	const jsdom = req("jsdom");
	wgxpath = req("wicked-good-xpath");
	serializeNode = req("w3c-xmlserializer");
	const Base = jsdom.JSDOM;
	// innerText is missing in jsdom (https://github.com/jsdom/jsdom/issues/1245); same shim as translation-server
	const shim = (window: any) => {
		Object.defineProperty(window.Attr.prototype, "innerText", {
			get() {
				return this.textContent;
			},
			set(v: string) {
				this.textContent = v;
			},
			configurable: true,
		});
		Object.defineProperty(window.Node.prototype, "innerText", {
			get() {
				const el = this.cloneNode(true);
				el.querySelectorAll?.("script, style").forEach((s: any) => s.remove());
				return el.textContent;
			},
			set(v: string) {
				this.textContent = v;
			},
			configurable: true,
		});
	};
	JSDOMClass = class extends Base {
		constructor(input: string, options: any = {}) {
			const before = options.beforeParse;
			options.beforeParse = (window: any) => {
				shim(window);
				before?.(window);
			};
			super(input, options);
		}
	};
	const g = globalThis as any;
	g.XPathResult = wgxpath.XPathResultType;
	const dom = new JSDOMClass("<html></html>");
	wgxpath.install(dom.window, true);
	g.DOMParser = dom.window.DOMParser;
	g.XMLSerializer = class XMLSerializer {
		serializeToString(node: unknown): string {
			return serializeNode(node);
		}
	};
}

/** A bare window for the DOM constructors (Node, Element, ...) the sandbox exposes. */
let base: any;
export function baseWindow(): any {
	load();
	return (base ??= new JSDOMClass("<html></html>").window);
}

export function installDomGlobals(): void {
	load();
}

export function makeDocument(html: string, url: string, contentType = "text/html"): any {
	load();
	const dom = new JSDOMClass(html, { url, contentType });
	wgxpath.install(dom.window, true);
	return dom.window.document;
}
