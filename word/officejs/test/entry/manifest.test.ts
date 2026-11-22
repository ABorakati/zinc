import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}

const VALID_ENTITY_RE = /^(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/;
const NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

function decodeXmlEntities(raw: string, context: string): string {
	if (raw.includes("<")) throw new Error(`Unescaped '<' in ${context}`);
	return raw.replace(/&([^;]*);|&/g, (full, entity: string | undefined) => {
		if (entity === undefined || !VALID_ENTITY_RE.test(entity)) {
			throw new Error(`Invalid XML entity '${full}' in ${context}`);
		}
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
				if (!Number.isFinite(code) || code <= 0) throw new Error(`Invalid numeric entity '&${entity};'`);
				return String.fromCodePoint(code);
			}
		}
	});
}

/** Strict well-formedness XML parser (no external dependencies): checks prolog, comments, attributes, entities, and tag balance. */
function parseWellFormedXml(src: string): XmlNode {
	let pos = 0;
	const n = src.length;
	if (src.charCodeAt(0) === 0xfeff) pos = 1;

	const skipWs = () => {
		while (pos < n && /\s/.test(src[pos]!)) pos++;
	};

	const skipMisc = () => {
		for (;;) {
			skipWs();
			if (src.startsWith("<!--", pos)) {
				const end = src.indexOf("-->", pos + 4);
				if (end < 0) throw new Error("Unterminated XML comment");
				if (src.slice(pos + 4, end).includes("--")) throw new Error("'--' is not permitted inside XML comments");
				pos = end + 3;
			} else if (src.startsWith("<?", pos)) {
				const end = src.indexOf("?>", pos + 2);
				if (end < 0) throw new Error("Unterminated processing instruction");
				pos = end + 2;
			} else {
				break;
			}
		}
	};

	skipWs();
	if (src.startsWith("<?xml", pos)) {
		const end = src.indexOf("?>", pos + 5);
		if (end < 0) throw new Error("Unterminated XML declaration");
		pos = end + 2;
	}
	skipMisc();

	const readName = (): string => {
		const start = pos;
		while (pos < n && !/[\s/>=?"'<]/.test(src[pos]!)) pos++;
		const name = src.slice(start, pos);
		if (!NAME_RE.test(name)) throw new Error(`Invalid XML name '${name}' at offset ${start}`);
		return name;
	};

	const parseElement = (): XmlNode => {
		if (src[pos] !== "<") throw new Error(`Expected '<' at offset ${pos}`);
		pos++;
		const name = readName();
		const attrs: Record<string, string> = {};

		for (;;) {
			skipWs();
			if (pos >= n) throw new Error(`Unexpected EOF in start tag <${name}>`);
			if (src.startsWith("/>", pos)) {
				pos += 2;
				return { name, attrs, children: [], text: "" };
			}
			if (src[pos] === ">") {
				pos++;
				break;
			}
			const attrName = readName();
			if (Object.hasOwn(attrs, attrName)) throw new Error(`Duplicate attribute '${attrName}' on <${name}>`);
			skipWs();
			if (src[pos] !== "=") throw new Error(`Expected '=' after attribute '${attrName}' on <${name}>`);
			pos++;
			skipWs();
			const quote = src[pos];
			if (quote !== '"' && quote !== "'") throw new Error(`Expected quoted value for attribute '${attrName}' on <${name}>`);
			pos++;
			const valStart = pos;
			const valEnd = src.indexOf(quote, valStart);
			if (valEnd < 0) throw new Error(`Unterminated attribute '${attrName}' on <${name}>`);
			attrs[attrName] = decodeXmlEntities(src.slice(valStart, valEnd), `attribute ${attrName}`);
			pos = valEnd + 1;
		}

		const children: XmlNode[] = [];
		let text = "";

		for (;;) {
			const lt = src.indexOf("<", pos);
			if (lt < 0) throw new Error(`Unclosed element <${name}>`);
			if (lt > pos) {
				text += decodeXmlEntities(src.slice(pos, lt), `<${name}> text`);
				pos = lt;
			}
			if (src.startsWith("<!--", pos)) {
				const end = src.indexOf("-->", pos + 4);
				if (end < 0) throw new Error("Unterminated XML comment");
				if (src.slice(pos + 4, end).includes("--")) throw new Error("'--' is not permitted inside XML comments");
				pos = end + 3;
			} else if (src.startsWith("<![CDATA[", pos)) {
				const end = src.indexOf("]]>", pos + 9);
				if (end < 0) throw new Error("Unterminated CDATA section");
				text += src.slice(pos + 9, end);
				pos = end + 3;
			} else if (src.startsWith("<?", pos)) {
				const end = src.indexOf("?>", pos + 2);
				if (end < 0) throw new Error("Unterminated processing instruction");
				pos = end + 2;
			} else if (src.startsWith("</", pos)) {
				pos += 2;
				const closeName = readName();
				skipWs();
				if (src[pos] !== ">") throw new Error(`Expected '>' in closing tag </${closeName}>`);
				pos++;
				if (closeName !== name) throw new Error(`Mismatched closing tag </${closeName}> for <${name}>`);
				return { name, attrs, children, text: text.trim() };
			} else {
				children.push(parseElement());
			}
		}
	};

	if (pos >= n) throw new Error("Empty XML document");
	const root = parseElement();
	skipMisc();
	if (pos !== n) throw new Error(`Trailing content after root element at offset ${pos}`);
	return root;
}

function findFirst(node: XmlNode, name: string): XmlNode | undefined {
	if (node.name === name) return node;
	for (const child of node.children) {
		const hit = findFirst(child, name);
		if (hit) return hit;
	}
	return undefined;
}

function findAll(node: XmlNode, name: string, acc: XmlNode[] = []): XmlNode[] {
	if (node.name === name) acc.push(node);
	for (const child of node.children) findAll(child, name, acc);
	return acc;
}

const manifestDir = join(import.meta.dir, "..", "..", "manifest");
const manifestPath = join(manifestDir, "manifest.xml");

describe("manifest/manifest.xml", () => {
	test("XML parser rejects malformed XML inputs", () => {
		expect(() => parseWellFormedXml("<OfficeApp><Id>1</OfficeApp>")).toThrow(/Mismatched closing tag/);
		expect(() => parseWellFormedXml('<OfficeApp a="1" a="2"/>')).toThrow(/Duplicate attribute/);
		expect(() => parseWellFormedXml("<OfficeApp>a & b</OfficeApp>")).toThrow(/Invalid XML entity/);
		expect(() => parseWellFormedXml("<A/><B/>")).toThrow(/Trailing content/);
	});

	test("is well-formed XML and satisfies Office TaskPaneApp manifest requirements", () => {
		const xml = readFileSync(manifestPath, "utf8");
		const root = parseWellFormedXml(xml);

		expect(root.name).toBe("OfficeApp");
		expect(root.attrs.xmlns).toBe("http://schemas.microsoft.com/office/appforoffice/1.1");
		expect(root.attrs["xsi:type"]).toBe("TaskPaneApp");

		// OffAppManifestV1_1.xsd + TaskPaneApp sequence order
		const childNames = root.children.map((c) => c.name);
		expect(childNames).toEqual([
			"Id",
			"Version",
			"ProviderName",
			"DefaultLocale",
			"DisplayName",
			"Description",
			"IconUrl",
			"HighResolutionIconUrl",
			"SupportUrl",
			"AppDomains",
			"Hosts",
			"Requirements",
			"DefaultSettings",
			"Permissions",
			"VersionOverrides",
		]);

		expect(findFirst(root, "Id")?.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(findFirst(root, "Permissions")?.text).toBe("ReadWriteDocument");
		expect(findFirst(root, "SupportUrl")?.attrs.DefaultValue).toBe("https://aborakati.github.io/zinc/");

		const hostNodes = findFirst(root, "Hosts")?.children ?? [];
		expect(hostNodes.some((h) => h.name === "Host" && h.attrs.Name === "Document")).toBe(true);

		const reqSet = findAll(root, "Set").find((s) => s.attrs.Name === "WordApi");
		expect(reqSet).toBeDefined();
		expect(Number.parseFloat(reqSet!.attrs.MinVersion ?? "0")).toBeGreaterThanOrEqual(1.5);

		const sourceLoc = findFirst(findFirst(root, "DefaultSettings")!, "SourceLocation");
		expect(sourceLoc?.attrs.DefaultValue).toBe("https://localhost:44321/taskpane.html");

		const domains = findAll(root, "AppDomain").map((d) => d.text);
		expect(domains.length).toBeGreaterThan(0);
		expect(domains).toContain("https://aborakati.github.io");

		expect(findFirst(root, "TaskpaneId")?.text).toBe("Office.AutoShowTaskpaneWithDocument");
	});

	test("all icon URLs resolve to valid PNG files in manifest/ with matching dimensions", () => {
		const root = parseWellFormedXml(readFileSync(manifestPath, "utf8"));
		const expectedIcons: { url: string; size: number }[] = [
			{ url: findFirst(root, "IconUrl")!.attrs.DefaultValue!, size: 32 },
			{ url: findFirst(root, "HighResolutionIconUrl")!.attrs.DefaultValue!, size: 64 },
		];
		for (const img of findAll(findFirst(root, "Resources")!, "bt:Image")) {
			const sizeMatch = /(\d+)$/.exec(img.attrs.id ?? "");
			if (sizeMatch && img.attrs.DefaultValue) {
				expectedIcons.push({ url: img.attrs.DefaultValue, size: Number(sizeMatch[1]) });
			}
		}

		for (const { url, size } of expectedIcons) {
			expect(url.startsWith("https://localhost:44321/")).toBe(true);
			const fileName = url.slice("https://localhost:44321/".length);
			const filePath = join(manifestDir, fileName);
			expect(existsSync(filePath)).toBe(true);

			const bytes = readFileSync(filePath);
			// 8-byte PNG magic header
			expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			// IHDR chunk starts at byte 8 (4-byte len, 4-byte "IHDR", 4-byte width, 4-byte height)
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe("IHDR");
			expect(view.getUint32(16, false)).toBe(size);
			expect(view.getUint32(20, false)).toBe(size);
		}
	});
});
