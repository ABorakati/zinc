// A plugin as ONE .wasm file: the plugin's own component (or module) with a custom section "zinc:package" appended, whose bytes are a
// zip of everything a .zplugin holds besides plugin.wasm (manifest.json, locale/, icons/, assets/). Custom sections carry no code:
// Wasmtime and every other tool skip them, so the file is still the same component.
//
//   embedPackage(wasm, files)   -> the single file (an older zinc:package section is replaced)
//   extractPackage(bytes)       -> the files of a .zplugin: the embedded ones plus "plugin.wasm" = the input WITHOUT the section
//
// The installer reads the manifest from the section without running anything, then checks main.sha256 against the stripped binary, so a
// plugin installed from a .wasm is byte for byte the one installed from the matching .zplugin. Only top-level sections are read
// (header, then id + LEB128 size + payload, repeated); nothing inside the code is parsed.
import { readZip, writeZip, ZipError, type ZipFile, type ZipLimits } from "./zip";

export const PACKAGE_SECTION = "zinc:package";

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** Starts with the WebAssembly magic (`\0asm`): a module or a component. */
export function isWasm(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b);
}

function readLeb(bytes: Uint8Array, at: number): { value: number; next: number } {
	let value = 0;
	let shift = 0;
	for (let i = at; i < bytes.length && i < at + 5; i++) {
		const b = bytes[i];
		value += (b & 0x7f) * 2 ** shift;
		if ((b & 0x80) === 0) return { value, next: i + 1 };
		shift += 7;
	}
	throw new ZipError("not a valid WebAssembly file (bad section size)");
}

function leb(n: number): number[] {
	const out: number[] = [];
	do {
		let b = n & 0x7f;
		n = Math.floor(n / 128);
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return out;
}

interface Section {
	start: number;
	end: number;
	id: number;
	/** custom sections only */
	name?: string;
	payload: Uint8Array;
}

/** The top-level sections, in order. Throws on a truncated file. */
function sections(bytes: Uint8Array): Section[] {
	const out: Section[] = [];
	let at = 8;
	const dec = new TextDecoder("utf-8", { fatal: false });
	while (at < bytes.length) {
		const start = at;
		const id = bytes[at];
		const size = readLeb(bytes, at + 1);
		const end = size.next + size.value;
		if (end > bytes.length) throw new ZipError("not a valid WebAssembly file (a section runs past the end)");
		let name: string | undefined;
		let payload = bytes.subarray(size.next, end);
		if (id === 0) {
			const n = readLeb(bytes, size.next);
			if (n.next + n.value > end) throw new ZipError("not a valid WebAssembly file (bad custom section name)");
			name = dec.decode(bytes.subarray(n.next, n.next + n.value));
			payload = bytes.subarray(n.next + n.value, end);
		}
		out.push({ start, end, id, name, payload });
		at = end;
	}
	return out;
}

/** The binary without any zinc:package section. */
export function stripPackage(bytes: Uint8Array): Uint8Array {
	const keep = sections(bytes).filter((s) => !(s.id === 0 && s.name === PACKAGE_SECTION));
	const parts = [bytes.subarray(0, 8), ...keep.map((s) => bytes.subarray(s.start, s.end))];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** One file: `wasm` (any old zinc:package section removed) with `files` (manifest.json, locale/, ...; not plugin.wasm) appended as a zip. */
export function embedPackage(wasm: Uint8Array, files: ZipFile[]): Uint8Array {
	if (!isWasm(wasm)) throw new ZipError("not a WebAssembly binary");
	const body = writeZip(files.filter((f) => f.name !== "plugin.wasm"));
	const name = new TextEncoder().encode(PACKAGE_SECTION);
	const content = [...leb(name.length), ...name];
	const size = content.length + body.length;
	const head = new Uint8Array([0, ...leb(size), ...content]);
	const code = stripPackage(wasm);
	const out = new Uint8Array(code.length + head.length + body.length);
	out.set(code, 0);
	out.set(head, code.length);
	out.set(body, code.length + head.length);
	return out;
}

/**
 * The files of the package inside a single-file plugin, with "plugin.wasm" = the binary without the section; undefined when the file
 * has no zinc:package section (a plain component: nothing says what it is or what it may do). The embedded zip is read with the same
 * limits as a .zplugin; a "plugin.wasm" inside it is ignored.
 */
export function extractPackage(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipFile[] | undefined {
	if (!isWasm(bytes)) return undefined;
	const pkg = sections(bytes).filter((s) => s.id === 0 && s.name === PACKAGE_SECTION);
	if (!pkg.length) return undefined;
	if (pkg.length > 1) throw new ZipError(`more than one ${PACKAGE_SECTION} section`);
	const all = readZip(pkg[0].payload, limits);
	// the binary goes in under the name the manifest gives it (always plugin.wasm today); an unreadable manifest is the installer's to report
	let main = "plugin.wasm";
	try {
		const mf = all.find((f) => f.name === "manifest.json");
		const m = mf && (JSON.parse(new TextDecoder().decode(mf.data)) as { main?: { wasm?: unknown } });
		if (typeof m?.main?.wasm === "string" && m.main.wasm) main = m.main.wasm;
	} catch {
		/* invalid JSON: installFiles says so */
	}
	return [...all.filter((f) => f.name !== main), { name: main, data: stripPackage(bytes) }];
}
