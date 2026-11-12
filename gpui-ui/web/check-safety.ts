// Safety gate for the headless browser checks (web/*-check.ts). Every check calls it before it starts Chrome.
//
// Why: Chrome for Testing reads native-messaging registrations under BOTH HKCU\Software\Chromium\NativeMessagingHosts AND
// HKCU\Software\Google\Chrome\NativeMessagingHosts. The installed Zinc host (com.zotero_next.connector_host, serving the user's real
// library) is registered under the Google key, with the connector's extension id as allowed origin, and the checks load extensions
// that carry that same id. So a test extension that calls connectNative with the real name (the connector's nativeHost.js and the
// library pages both default to it) starts the user's real host. A check must therefore make sure that nothing it loads can reach a
// name registered under the Google key.
//
// What a check does:
//   - an extension it generates: put `zinc_test: true` in the manifest (testManifest) and pass its own host name as ?host=. The
//     library pages (extension.tsx, reader-tab/zn-bridge.ts) then never fall back to the real name (native-host.ts resolveHostName).
//   - a copy of the connector build: makeConnectorTestCopy (an unregistered name in place of the real one, in every script).
//   - then assertSafeToStart({ extDir, hostNames }) right before spawning Chrome. It throws, and nothing starts, when a host name the
//     check will use is registered under the Google key, when the manifest is not a test manifest, or when a script that could
//     connect still names a Google-registered host (and does not carry the zinc_test guard).
// It only reads the registry; it never writes it.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REAL_HOST_NAME = "com.zotero_next.connector_host";
/** Registered nowhere: what a copy of the connector uses so that it has no native host. */
export const UNREGISTERED_HOST_NAME = "com.zotero_next.connector_host_unregistered_check";
const GUARD_MARKER = "zinc_test"; // appears in library pages built from a source with the guard (native-host.ts resolveHostName)
const KEYS = { chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts", google: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" } as const;

/** The host names registered under each key (`reg query`, read-only). */
export function registeredHosts(): { chromium: string[]; google: string[] } {
	const list = (key: string): string[] => {
		const r = spawnSync("reg", ["query", key], { encoding: "utf8" });
		if (r.error) throw new Error(`check-safety: cannot run reg query: ${r.error.message}`);
		// reg prints the subkeys with the long root name (HKEY_CURRENT_USER\...), whatever form was asked for
		const prefix = key.replace(/^HKCU/i, "HKEY_CURRENT_USER").toLowerCase() + "\\";
		const out = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.toLowerCase().startsWith(prefix)).map((l) => l.slice(prefix.length));
		// exit 1 with nothing printed = the key does not exist (no hosts registered there); anything else unexpected must not pass as "none"
		if (r.status !== 0 && !/unable to find|cannot find/i.test(r.stderr)) throw new Error(`check-safety: reg query ${key} failed: ${r.stderr || r.stdout}`);
		return out;
	};
	return { chromium: list(KEYS.chromium), google: list(KEYS.google) };
}

/** A manifest for a test extension: marks it so the library pages never default to the real host. */
export const testManifest = <T extends object>(m: T): T & { zinc_test: true } => ({ ...m, zinc_test: true });

const SCRIPT = /\.(m?js|html?)$/i;
function* files(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		let st;
		try { st = statSync(p); } catch { continue; } // follows junctions and links, as Chrome does
		if (st.isDirectory()) yield* files(p);
		else if (SCRIPT.test(name)) yield p;
	}
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A copy of the connector build (dest) that has no native host: in every script, the real host name is replaced by one registered
 * nowhere, and the manifest is marked zinc_test. Links in the source are followed (copied as plain files).
 */
export function makeConnectorTestCopy(src: string, dest: string, replacement = UNREGISTERED_HOST_NAME): void {
	cpSync(src, dest, { recursive: true, dereference: true });
	const re = new RegExp(`(["'\`])${escapeRe(REAL_HOST_NAME)}\\1`, "g");
	let changed = 0;
	for (const f of files(dest)) {
		const t = readFileSync(f, "utf8");
		const u = t.replace(re, (_m, q: string) => { changed++; return q + replacement + q; });
		if (u !== t) writeFileSync(f, u);
	}
	if (!changed) throw new Error(`check-safety: no use of ${REAL_HOST_NAME} found in ${src}; is it a connector build?`);
	const mf = join(dest, "manifest.json");
	writeFileSync(mf, JSON.stringify(testManifest(JSON.parse(readFileSync(mf, "utf8"))), null, 2));
}

/**
 * Throws, with a clear message, unless starting Chrome with extDir cannot reach a host registered under the Google key.
 * hostNames: every native host name the check will connect to (its own test host(s)).
 */
export function assertSafeToStart(opts: { extDir: string; hostNames?: string[] }): { chromium: string[]; google: string[] } {
	const reg = registeredHosts();
	const google = new Set(reg.google);
	const refuse = (why: string): never => {
		throw new Error(`REFUSING TO START CHROME (web/check-safety.ts): ${why}\n  Chrome for Testing reads native hosts registered under HKCU\\Software\\Google\\Chrome too (here: ${[...google].join(", ") || "none"}), so this run could reach the user's real host and library.`);
	};
	for (const n of opts.hostNames ?? []) if (google.has(n)) refuse(`the test host name "${n}" is registered under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts`);
	const mf = join(opts.extDir, "manifest.json");
	if (!existsSync(mf)) refuse(`${mf} does not exist`);
	const manifest = JSON.parse(readFileSync(mf, "utf8")) as { zinc_test?: boolean };
	if (manifest.zinc_test !== true) refuse(`${mf} is not a test manifest (zinc_test: true; use testManifest or makeConnectorTestCopy)`);
	// no script may still name a Google-registered host, unless it sits with the zinc_test guard (the library pages: they name the real
	// host only to compare against it, and the manifest field above makes them use another name)
	const names = [...google].map((n) => ({ n, re: new RegExp(`(["'\`])${escapeRe(n)}\\1`) })); // the name as a string of its own (not inside a registry path or a file name)
	// (the build is split into chunks: a folder counts as guarded when any script in it carries the marker)
	const all = [...files(opts.extDir)].map((f) => ({ f, t: readFileSync(f, "utf8") }));
	const guarded = new Set(all.filter(({ t }) => t.includes(GUARD_MARKER)).map(({ f }) => dirname(f)));
	for (const { f, t } of all) {
		const hit = names.find(({ re }) => re.test(t));
		if (hit && !guarded.has(dirname(f))) refuse(`${f} names the registered host "${hit.n}" and has no zinc_test guard (rebuild the library page with this source, or make a test copy of the connector with makeConnectorTestCopy)`);
	}
	return reg;
}
