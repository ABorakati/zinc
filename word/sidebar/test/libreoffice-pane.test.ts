// Full stack, minus the native docking: the real sidebar page (the bundle Word uses) in the LibreOffice pane process's WebView2,
// with the pane answering lib.* / style.* from a synthetic library through the Word add-in's C# code, and every doc.* the
// page sends forwarded here and on to a private headless LibreOffice (libreoffice/test/harness.py), as the extension does
// inside LibreOffice. The page is clicked through like a user: search, click a result (inserts), Insert bibliography, Refresh.
// The pane's window is off-screen and never activated; soffice is headless. Off by default. Run with:
//   pwsh libreoffice/build.ps1   (builds the pane)   then
//   ZN_LO_E2E=1 ZN_LO_PROGRAM="<LibreOffice>/program" bun test test/libreoffice-pane.test.ts
// ZN_LO_PANE_SHOT=<file.png> also saves a picture of the page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrefsXml } from "../src/fields";
import { LoHarnessHost, loAvailable } from "./lo-harness-host";

const ENABLED = process.env.ZN_LO_E2E === "1";
const ROOT = join(import.meta.dir, "..", "..", "..");
const PANE_EXE = process.env.ZN_LO_PANE ?? join(ROOT, "libreoffice", "dist", "pane", "ZincLibreOfficePane.exe");
const FIX = join(ROOT, "core", "test", "cite", "fixtures");
const d = ENABLED ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Pane {
	proc!: ReturnType<typeof Bun.spawn>;
	private waiters: ((m: any) => boolean)[] = [];
	/** every doc.* request the page sent, in order */
	readonly docCalls: string[] = [];

	constructor(private lo: LoHarnessHost) {}

	start(args: string[]) {
		this.proc = Bun.spawn([PANE_EXE, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		void this.read();
	}

	private send(obj: unknown) {
		const s = this.proc.stdin as import("bun").FileSink;
		s.write(JSON.stringify(obj) + "\n");
		s.flush();
	}

	private async read() {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const m = JSON.parse(line);
				if (typeof m.method === "string" && m.method.startsWith("doc.")) void this.answer(m);
				else this.waiters = this.waiters.filter((w) => !w(m));
			}
		}
	}

	/** What the extension does with a doc.* request: run it against LibreOffice, send the answer back unchanged. */
	private async answer(m: { id: number; method: string; params?: Record<string, unknown> }) {
		this.docCalls.push(m.method);
		try {
			this.send({ id: m.id, result: await this.lo.raw(m.method, m.params ?? {}) });
		} catch (e) {
			this.send({ id: m.id, error: { message: e instanceof Error ? e.message : String(e) } });
		}
	}

	wait(pred: (m: any) => boolean, ms = 30000): Promise<any> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("pane: timed out")), ms);
			this.waiters.push((m) => {
				if (!pred(m)) return false;
				clearTimeout(t);
				resolve(m);
				return true;
			});
		});
	}

	async attach() {
		const ready = this.wait((m) => m.pane === "ready", 60000);
		this.send({ pane: "attach", hwnd: 0, theme: "light" });
		await ready;
	}

	async eval<T = any>(js: string): Promise<T> {
		const r = this.wait((m) => m.pane === "eval");
		this.send({ pane: "eval", js });
		const m = await r;
		if (m.error) throw new Error(m.error);
		return JSON.parse(m.json) as T;
	}

	async until<T>(js: string, ok: (v: T) => boolean, ms = 20000): Promise<T> {
		const end = Date.now() + ms;
		let v = await this.eval<T>(js);
		while (!ok(v)) {
			if (Date.now() > end) throw new Error(`pane: ${js} stayed ${JSON.stringify(v)}`);
			await sleep(100);
			v = await this.eval<T>(js);
		}
		return v;
	}

	async capture(path: string) {
		const r = this.wait((m) => m.pane === "capture");
		this.send({ pane: "capture", path });
		return r;
	}

	async stop() {
		try {
			this.send({ pane: "quit" });
		} catch {}
		const code = await Promise.race([this.proc.exited, sleep(8000).then(() => -1)]);
		if (code === -1) this.proc.kill();
	}
}

d("the sidebar page in the LibreOffice pane, driving a headless LibreOffice", () => {
	let lo: LoHarnessHost;
	let pane: Pane;

	beforeAll(async () => {
		if (!loAvailable()) throw new Error("set ZN_LO_PROGRAM to LibreOffice's program folder");
		if (!existsSync(PANE_EXE)) throw new Error("build the pane first: pwsh libreoffice/build.ps1");
		const tmp = mkdtempSync(join(tmpdir(), "zn-lo-pane-"));
		// the sidebar bundle, built into the temp folder (word/dist is left alone)
		const b = Bun.spawnSync([process.execPath, "build.ts"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, ZN_WORD_DIST: tmp },
		});
		if (b.exitCode !== 0) throw new Error("sidebar build failed: " + b.stderr.toString());
		// a synthetic library, made by core's own code (as word-track.test.ts does)
		const CORE = join(ROOT, "core");
		const { openDb } = await import(join(CORE, "src", "db.ts"));
		const { rebuildSearchIndex } = await import(join(CORE, "src", "search.ts"));
		const { insertItem } = await import(join(CORE, "test", "fixture.ts"));
		const dbPath = join(tmp, "lib.sqlite");
		const db = openDb(dbPath);
		for (let i = 1; i <= 6; i++)
			insertItem(db, {
				key: "LOIT" + String(i).padStart(4, "0"),
				itemType: "journalArticle",
				title: `Liver transplantation outcomes study number ${i}`,
				creators: [{ creatorType: "author", firstName: "Ann", lastName: "Author" + i }],
				date: String(2000 + i),
				publicationTitle: "Journal of Hepatology",
			});
		rebuildSearchIndex(db);
		db.close();
		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "styles"), { recursive: true });
		mkdirSync(join(cache, "locales"), { recursive: true });
		cpSync(join(FIX, "vancouver.csl"), join(cache, "styles", "vancouver.csl"));
		cpSync(join(FIX, "locales-en-US.xml"), join(cache, "locales", "locales-en-US.xml"));
		writeFileSync(join(tmp, "settings.json"), JSON.stringify({ dbPath, style: "vancouver" }));

		lo = await LoHarnessHost.start(join(tmp, "profile"));
		await lo.raw("h.start");
		await lo.raw("h.newDoc");
		await lo.raw("h.type", { text: "Outcomes differ between centres" });
		pane = new Pane(lo);
		pane.start(["--site", join(tmp, "addin", "sidebar"), "--settings", join(tmp, "settings.json"), "--cache", cache, "--db", dbPath]);
		await pane.attach();
	}, 180_000);

	afterAll(async () => {
		await pane?.stop();
		await lo?.stop();
	}, 60_000);

	test("the page loads and searches the library through the pane", async () => {
		await pane.until<number>(`document.querySelectorAll('#results li').length`, (n) => n === 6);
		await pane.eval(
			`(() => { const q = document.getElementById('q'); q.value = 'study number 4'; q.dispatchEvent(new Event('input')); return true; })()`,
		);
		const titles = await pane.until<string[]>(
			`[...document.querySelectorAll('#results li')].map((li) => li.textContent)`,
			(t) => t.length === 1,
		);
		expect(titles[0]).toContain("study number 4");
	}, 60_000);

	test("clicking a result inserts a citation into the LibreOffice document", async () => {
		await pane.eval(`(document.querySelector('#results li').click(), true)`);
		const fields = await waitFields(lo, (f) => f.length === 1 && f[0].text === "(1)");
		expect(fields[0].kind).toBe("item");
		const marks = await lo.raw<{ marks: string[] }>("h.marks");
		expect(marks.marks[0]).toMatch(/^ZOTERO_ITEM CSL_CITATION \{.*\/items\/LOIT0004".*\} RND[0-9A-Za-z]{10}$/s);
		// host.info from the pane says LibreOffice: the new document's prefs name reference marks, as Zotero expects
		const props = await lo.raw<Record<string, string>>("h.props");
		expect(parsePrefsXml(props.ZOTERO_PREF_1 + (props.ZOTERO_PREF_2 ?? "") + (props.ZOTERO_PREF_3 ?? ""))!.fieldType).toBe(
			"ReferenceMark",
		);
		expect((await lo.raw<{ text: string }>("h.text")).text).toBe("Outcomes differ between centres(1)");
	}, 60_000);

	test("Insert bibliography and Refresh buttons work against LibreOffice", async () => {
		await lo.raw("h.cursorEnd");
		await lo.raw("h.para");
		await pane.eval(`(document.getElementById('bib').click(), true)`);
		const fields = await waitFields(lo, (f) => f.length === 2);
		expect(fields[1].kind).toBe("bibl");
		expect(fields[1].text).toContain("Author4 A. Liver transplantation outcomes study number 4");
		pane.docCalls.length = 0;
		await pane.eval(`(document.getElementById('refresh').click(), true)`);
		await pane.until<string>(`document.body.innerText`, (t) => /Refreshed/.test(t));
		expect(pane.docCalls).toContain("doc.fields");
		expect(pane.docCalls.filter((c) => c === "doc.set").length).toBe(0);
		const shot = process.env.ZN_LO_PANE_SHOT;
		if (shot) expect((await pane.capture(shot)).path).toBe(shot);
	}, 60_000);
});

async function waitFields(lo: LoHarnessHost, ok: (f: any[]) => boolean, ms = 20000): Promise<any[]> {
	const end = Date.now() + ms;
	for (;;) {
		const f = await lo.raw<any[]>("doc.fields");
		if (ok(f)) return f;
		if (Date.now() > end) throw new Error("document fields stayed " + JSON.stringify(f));
		await sleep(150);
	}
}
