// net, fs, clipboard, shell and the notifier hub: the handlers that stand between a plugin and the machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerTable } from "../../src/imports/registry";
import net from "../../src/imports/net.host";
import fsHost from "../../src/imports/fs.host";
import fsZinc from "../../src/imports/fs.zinc";
import clipboard from "../../src/imports/clipboard.zinc";
import shell, { checkFileName, checkOpenUrl } from "../../src/imports/shell.zinc";
import { addGrant, configureFs, pathSegments } from "../../src/imports/data/fs-roots";
import { setFilePicker } from "../../src/imports/data/pick-hook";
import { setClipboardBackend, setShellBackend } from "../../src/imports/data/os-hooks";
import { netHostAllowed, isPrivateHost } from "../../src/imports/data/nethosts";
import { NotifierHub, QUEUE_LIMIT, type WitBatch } from "../../src/imports/data/notifier-hub";
import notifier, { resetNotifier } from "../../src/imports/notifier.host";
import { call, failure, fakeCtx, manifestOf, startCore, until, wait, type TestCore } from "./core-fixture";

// ------------------------------------------------------------------------------------------------ net
let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: { headers: Record<string, string>; method: string; body: string }[] = [];
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const u = new URL(req.url);
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			seen.push({ headers, method: req.method, body: await req.text() });
			if (u.pathname === "/echo") return Response.json({ ok: true });
			if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: u.searchParams.get("to") ?? "/echo" } });
			if (u.pathname === "/status") return new Response("nope", { status: Number(u.searchParams.get("code")) });
			if (u.pathname === "/big") return new Response(new Uint8Array(Number(u.searchParams.get("n"))));
			if (u.pathname === "/cookie") return new Response("c", { headers: { "Set-Cookie": "sid=abc123; Path=/" } });
			if (u.pathname === "/slow") {
				await wait(2000);
				return new Response("late");
			}
			if (u.pathname === "/stream")
				return new Response(
					new ReadableStream({
						async start(c) {
							for (const p of ["alpha", "beta", "gamma"]) {
								c.enqueue(new TextEncoder().encode(p));
								await wait(20);
							}
							c.close();
						},
					}),
				);
			if (u.pathname === "/flaky") {
				const n = (flaky.n = (flaky.n ?? 0) + 1);
				return n < 3 ? new Response("busy", { status: 503 }) : new Response("fine");
			}
			return new Response("hello world");
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
const flaky: { n?: number } = {};

const request = (url: string, over: Record<string, unknown> = {}) => ({
	method: "GET",
	url,
	headers: [],
	body: undefined,
	timeoutMs: undefined,
	successCodes: undefined,
	redirect: "follow",
	credentials: undefined,
	cookies: { tag: "none" },
	retry: undefined,
	bypassCache: false,
	maxResponseBytes: undefined,
	cancelKey: undefined,
	...over,
});
const netCtx = (hosts: string[]) => fakeCtx(undefined, manifestOf({ netHosts: hosts }));

describe("net", () => {
	test("allowlist: unlisted hosts, schemes and private ranges are blocked with the rule named", async () => {
		const c = netCtx([base]);
		expect((await call(net, c, "send", request(`${base}/echo`))).status).toBe(200);
		expect(await failure(call(net, netCtx([]), "send", request(`${base}/echo`)))).toMatchObject({ tag: "blocked" });
		expect(await failure(call(net, c, "send", request("http://127.0.0.1:1/echo")))).toMatchObject({ tag: "blocked" }); // other port
		expect(await failure(call(net, c, "send", request("file:///C:/Windows/win.ini")))).toMatchObject({ tag: "blocked" });
		expect(await failure(call(net, netCtx(["*"]), "send", request(`${base}/echo`)))).toMatchObject({ tag: "blocked" }); // `*` is public hosts only
		expect(await failure(call(net, c, "send", request(`http://user:pw@127.0.0.1:${server.port}/echo`)))).toMatchObject({ tag: "blocked" });
		expect(netHostAllowed(["*.example.org"], new URL("https://a.b.example.org/x"))).toBe(true);
		expect(netHostAllowed(["*.example.org"], new URL("https://example.org/x"))).toBe(false);
		expect(netHostAllowed(["example.org"], new URL("http://example.org/x"))).toBe(false); // https assumed
		expect(netHostAllowed(["http://example.org"], new URL("http://example.org/x"))).toBe(true);
		expect(netHostAllowed(["*"], new URL("https://public.example/x"))).toBe(true);
		expect(netHostAllowed(["*"], new URL("https://192.168.1.5/x"))).toBe(false);
		expect(netHostAllowed(["*"], new URL("http://[::1]:8080/x"))).toBe(false);
		expect(["10.0.0.1", "172.20.1.1", "169.254.169.254", "fd00::1", "::ffff:127.0.0.1", "localhost"].every(isPrivateHost)).toBe(true);
		expect(isPrivateHost("8.8.8.8")).toBe(false);
	});

	test("a redirect to a host that is not allowed is blocked at the hop", async () => {
		const c = netCtx([base]);
		const f = await failure(call(net, c, "send", request(`${base}/redirect?to=${encodeURIComponent("http://localhost:" + server.port + "/echo")}`)));
		expect(f).toMatchObject({ tag: "blocked" });
		expect((await call(net, c, "send", request(`${base}/redirect?to=/echo`))).url).toBe(`${base}/echo`);
		const manual = await call(net, c, "send", request(`${base}/redirect?to=/echo`, { redirect: "manual", successCodes: [302] }));
		expect(manual.status).toBe(302);
	});

	test("headers: the host owns Host, Cookie, Proxy-*, Sec-*; the default User-Agent is Zinc's", async () => {
		const c = netCtx([base]);
		seen.length = 0;
		await call(net, c, "send", request(`${base}/echo`, { method: "POST", body: new TextEncoder().encode("payload"), headers: [{ name: "X-Mine", value: "1" }, { name: "Cookie", value: "steal=1" }, { name: "Proxy-Authorization", value: "x" }, { name: "Sec-Fetch-Mode", value: "x" }, { name: "Host", value: "evil.test" }] }));
		const h = seen.at(-1)!;
		expect(h.method).toBe("POST");
		expect(h.body).toBe("payload");
		expect(h.headers["x-mine"]).toBe("1");
		expect(h.headers.cookie).toBeUndefined();
		expect(h.headers["proxy-authorization"]).toBeUndefined();
		expect(h.headers["sec-fetch-mode"]).toBeUndefined();
		expect(h.headers.host).toBe(`127.0.0.1:${server.port}`);
		expect(h.headers["user-agent"]).toStartWith("Zinc/");
		await call(net, c, "send", request(`${base}/echo`, { headers: [{ name: "User-Agent", value: "Mine/2 (me@x.org)" }], credentials: { username: "u", password: "p" } }));
		expect(seen.at(-1)!.headers["user-agent"]).toBe("Mine/2 (me@x.org)");
		expect(seen.at(-1)!.headers.authorization).toBe("Basic " + btoa("u:p"));
	});

	test("success codes, size cap, timeout, cancel, retry", async () => {
		const c = netCtx([base]);
		const bad = await failure(call(net, c, "send", request(`${base}/status?code=404`)));
		expect(bad?.tag).toBe("unexpected-status");
		expect((bad?.val as any).status).toBe(404);
		expect(new TextDecoder().decode((bad?.val as any).body)).toBe("nope");
		expect((await call(net, c, "send", request(`${base}/status?code=404`, { successCodes: [] }))).status).toBe(404);
		expect(await failure(call(net, c, "send", request(`${base}/big?n=5000`, { maxResponseBytes: 1000n })))).toEqual({ tag: "too-large" });
		expect((await call(net, c, "send", request(`${base}/big?n=5000`, { maxResponseBytes: 10_000n }))).body.length).toBe(5000);
		expect(await failure(call(net, c, "send", request(`${base}/slow`, { timeoutMs: 200 })))).toEqual({ tag: "timeout" });
		const slow = call(net, c, "send", request(`${base}/slow`, { cancelKey: "k1" }));
		await wait(100);
		await call(net, c, "cancel", "k1");
		expect(await failure(slow)).toEqual({ tag: "cancelled" });
		const ok = await call(net, c, "send", request(`${base}/flaky`, { retry: { delaysMs: [10, 10], maxTotalMs: 1000, surfaceThrottle: false } }));
		expect(new TextDecoder().decode(ok.body)).toBe("fine");
		expect((await call(net, c, "send-many", [request(`${base}/echo`), request(`${base}/status?code=500`)])).map((r: any) => r.tag)).toEqual(["ok", "err"]);
		expect(await failure(call(net, c, "send-many", Array.from({ length: 17 }, () => request(`${base}/echo`))))).toMatchObject({ tag: "other" });
	});

	test("cookie jar: private to the plugin, sent back, listed, cleared", async () => {
		const c = netCtx([base]);
		await call(net, c, "send", request(`${base}/cookie`, { cookies: { tag: "jar", val: "j" } }));
		seen.length = 0;
		await call(net, c, "send", request(`${base}/echo`, { cookies: { tag: "jar", val: "j" } }));
		expect(seen.at(-1)!.headers.cookie).toBe("sid=abc123");
		await call(net, c, "send", request(`${base}/echo`, { cookies: { tag: "none" } }));
		expect(seen.at(-1)!.headers.cookie).toBeUndefined();
		expect(await call(net, c, "list-cookies", "j", "127.0.0.1")).toEqual([{ name: "sid", value: "abc123" }]);
		const other = fakeCtx(undefined, manifestOf({ id: "other@zinc.test", netHosts: [base] }));
		expect(await call(net, other, "list-cookies", "j", "127.0.0.1")).toEqual([]);
		await call(net, c, "clear-cookie-jar", "j");
		expect(await call(net, c, "list-cookies", "j", "127.0.0.1")).toEqual([]);
	});

	test("send-streamed returns a body-reader that reads in pieces and closes", async () => {
		const c = netCtx([base]);
		const table = new HandlerTable([net]);
		const refs: any[] = [];
		const ctx = { ...c, resource: (name: string, state: unknown) => (refs.push(state), { "$zinc-resource": name, id: -(refs.length) }) } as typeof c;
		const res = await table.call(ctx, net.interface, "send-streamed", [request(`${base}/stream`)]);
		expect(res.status).toBe(200);
		const rid = res.body.id;
		// the table made the handle through ctx.resource: register the state under that id the way the host process does
		const t2 = new HandlerTable([net]);
		const handle = t2.createResource(c.pluginId, "body-reader", refs[0]);
		let text = "";
		for (;;) {
			const chunk = await t2.call(c, net.interface, "[method]body-reader.read", [handle.id, 4]);
			if (chunk === undefined) break;
			expect(chunk.length).toBeLessThanOrEqual(4);
			text += new TextDecoder().decode(chunk);
		}
		expect(text).toBe("alphabetagamma");
		expect(await t2.call(c, net.interface, "[method]body-reader.read", [handle.id, 4])).toBeUndefined();
		await t2.call(c, net.interface, "[method]body-reader.close", [handle.id]);
		expect(await failure(call(net, c, "send-streamed", request(`${base}/status?code=500`)))).toMatchObject({ tag: "unexpected-status" });
	});
});

// ------------------------------------------------------------------------------------------------- fs
let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zn-fs-test-"));
	configureFs({ dataRoot: join(root, "data"), tempRoot: join(root, "temp"), bundledDirFor: (id) => (id === "data-test@zinc.test" ? join(root, "pkg") : undefined) });
	mkdirSync(join(root, "pkg"), { recursive: true });
	writeFileSync(join(root, "pkg", "icon.txt"), "bundled!");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const data = (path: string) => ({ root: { tag: "data" }, path });
const WRITE = { createParents: true, onConflict: "overwrite", atomic: true };

describe("fs", () => {
	test("data root: write, read, text, append, stat, list, copy, move, remove", async () => {
		const c = fakeCtx(undefined);
		const out = await call(fsHost, c, "write-text", data("notes/a.txt"), "héllo", WRITE);
		expect(out).toEqual(data("notes/a.txt"));
		expect(await call(fsHost, c, "read-text", data("notes/a.txt"))).toBe("héllo");
		expect(new TextDecoder().decode(await call(fsHost, c, "read", data("notes/a.txt")))).toBe("héllo");
		await call(fsHost, c, "append", data("notes/a.txt"), new TextEncoder().encode("!"));
		expect(await call(fsHost, c, "read-text", data("notes/a.txt"))).toBe("héllo!");
		expect([...(await call(fsHost, c, "read-range", data("notes/a.txt"), 1n, 2))]).toEqual([...new TextEncoder().encode("é")]);
		const st = await call(fsHost, c, "stat", data("notes/a.txt"));
		expect(st).toMatchObject({ kind: "file", size: 7n });
		expect(await call(fsHost, c, "stat", data("nope.txt"))).toBeUndefined();
		expect((await call(fsHost, c, "list-dir", data("notes"))).map((e: any) => e.name)).toEqual(["a.txt"]);
		// conflict modes
		expect((await failure(call(fsHost, c, "write-text", data("notes/a.txt"), "x", { createParents: false, onConflict: "fail", atomic: false })))?.tag).toBe("conflict");
		const renamed = await call(fsHost, c, "write-text", data("notes/a.txt"), "second", { createParents: false, onConflict: "rename-unique", atomic: false });
		expect(renamed).toEqual(data("notes/a 2.txt"));
		await call(fsHost, c, "copy", data("notes/a.txt"), data("copy/b.txt"), "fail");
		expect(await call(fsHost, c, "read-text", data("copy/b.txt"))).toBe("héllo!");
		await call(fsHost, c, "move", data("copy/b.txt"), data("moved/c.txt"), "fail");
		expect(await call(fsHost, c, "stat", data("copy/b.txt"))).toBeUndefined();
		await call(fsHost, c, "remove", data("moved"), true);
		expect(await call(fsHost, c, "stat", data("moved"))).toBeUndefined();
		await call(fsHost, c, "remove", data("moved"), true); // missing is not an error
		await call(fsHost, c, "make-dir", data("x/y/z"), true);
		expect((await call(fsHost, c, "stat", data("x/y/z"))).kind).toBe("directory");
		expect((await failure(call(fsHost, c, "read", data("nope.txt"))))?.tag).toBe("not-found");
		expect((await failure(call(fsHost, c, "remove", data(""), true)))?.tag).toBe("invalid-argument"); // not the root itself
		// roots are separate per plugin
		const other = fakeCtx(undefined, manifestOf({ id: "other@zinc.test" }));
		expect(await call(fsHost, other, "stat", data("notes/a.txt"))).toBeUndefined();
	});

	test("paths: no traversal, absolute, drive letters, reserved names, odd characters", async () => {
		const c = fakeCtx(undefined);
		for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows/win.ini", "C:x", "a//b", "a/./b", "NUL", "con.txt", "a/COM1", "a\\b", "a:b", "a?", "name.", "name ", "a/\u0000"]) {
			expect((await failure(call(fsHost, c, "read", data(bad))))?.tag).toBe("invalid-argument");
		}
		expect(pathSegments("a/b c/d.txt")).toEqual(["a", "b c", "d.txt"]);
		expect((await failure(call(fsHost, c, "read", { root: { tag: "weird" }, path: "x" })))?.tag).toBe("invalid-argument");
	});

	test("symbolic links never lead out of the root", async () => {
		const c = fakeCtx(undefined);
		await call(fsHost, c, "make-dir", data("links"), true);
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret");
		try {
			symlinkSync(outside, join(root, "data", "data-test@zinc.test", "links", "escape"), "junction");
		} catch {
			return; // no permission to make links here
		}
		expect((await failure(call(fsHost, c, "read", data("links/escape/secret.txt"))))?.tag).toBe("permission-denied");
		expect((await failure(call(fsHost, c, "write-text", data("links/escape/new.txt"), "x", WRITE)))?.tag).toBe("permission-denied");
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
	});

	test("bundled is read only; temp is a scratch root", async () => {
		const c = fakeCtx(undefined);
		expect(await call(fsHost, c, "read-text", { root: { tag: "bundled" }, path: "icon.txt" })).toBe("bundled!");
		expect((await failure(call(fsHost, c, "write-text", { root: { tag: "bundled" }, path: "icon.txt" }, "x", WRITE)))?.tag).toBe("read-only");
		await call(fsHost, c, "write-text", { root: { tag: "temp" }, path: "t.txt" }, "tmp", WRITE);
		expect(readFileSync(join(root, "temp", "data-test@zinc.test", "t.txt"), "utf8")).toBe("tmp");
	});

	test("quota: a write over 512 MiB is refused", async () => {
		const c = fakeCtx(undefined);
		const big = new Uint8Array(200 * 1024 * 1024);
		await call(fsHost, c, "write", data("q/1.bin"), big, WRITE);
		await call(fsHost, c, "write", data("q/2.bin"), big, WRITE);
		expect((await failure(call(fsHost, c, "write", data("q/3.bin"), big, WRITE)))?.tag).toBe("limit-exceeded");
		await call(fsHost, c, "remove", data("q"), true);
	});

	test("grants: the picker hook makes a grant, the host reads and writes through it, a read grant refuses writes", async () => {
		const c = fakeCtx(undefined);
		const picked = join(root, "user-file.txt");
		const pickedDir = join(root, "user-dir");
		const saveTarget = join(root, "save-here.txt");
		writeFileSync(picked, "user data");
		mkdirSync(pickedDir, { recursive: true });
		writeFileSync(join(pickedDir, "inner.txt"), "inner");
		expect((await failure(call(fsZinc, c, "pick-open", { filters: [], persistent: false }, false)))?.tag).toBe("unavailable"); // default deny
		const asked: any[] = [];
		setFilePicker(async (req) => {
			asked.push(req.kind);
			if (req.kind === "directory") return [{ path: pickedDir, isDirectory: true }];
			if (req.kind === "save") return [{ path: saveTarget, isDirectory: false }];
			return [{ path: picked, isDirectory: false }];
		});
		try {
			const [g] = await call(fsZinc, c, "pick-open", { title: "t", filters: [], persistent: false }, false);
			expect(g).toMatchObject({ name: "user-file.txt", isDirectory: false });
			expect(g).not.toHaveProperty("path");
			const ref = { root: { tag: "granted", val: g.id }, path: "" };
			expect(await call(fsHost, c, "read-text", ref)).toBe("user data");
			expect((await failure(call(fsHost, c, "write-text", ref, "x", WRITE)))?.tag).toBe("permission-denied");
			expect((await failure(call(fsHost, c, "read-text", { root: { tag: "granted", val: g.id }, path: "sub" })))?.tag).toBe("invalid-argument");
			expect((await failure(call(fsHost, c, "read-text", { root: { tag: "granted", val: "nope" }, path: "" })))?.tag).toBe("permission-denied");
			const dir = await call(fsZinc, c, "pick-directory", { filters: [], persistent: false });
			const dref = (p: string) => ({ root: { tag: "granted", val: dir.id }, path: p });
			expect(await call(fsHost, c, "read-text", dref("inner.txt"))).toBe("inner");
			await call(fsHost, c, "write-text", dref("made.txt"), "new", WRITE);
			expect(readFileSync(join(pickedDir, "made.txt"), "utf8")).toBe("new");
			expect((await failure(call(fsHost, c, "read", dref("../user-file.txt"))))?.tag).toBe("invalid-argument");
			const save = await call(fsZinc, c, "pick-save", { filters: [], persistent: false }, "out.txt");
			await call(fsHost, c, "write-text", { root: { tag: "granted", val: save.id }, path: "" }, "saved", WRITE);
			expect(readFileSync(saveTarget, "utf8")).toBe("saved");
			expect((await call(fsHost, c, "list-grants")).map((x: any) => x.id).sort()).toEqual([g.id, dir.id, save.id].sort());
			await call(fsHost, c, "release-grant", g.id);
			expect((await failure(call(fsHost, c, "read-text", ref)))?.tag).toBe("permission-denied");
			// a drop is the same kind of grant (the ui agent calls addGrant)
			const dropped = addGrant(c.pluginId, { path: picked, isDirectory: false, mode: "read", size: 9 });
			expect(dropped.size).toBe(9n);
			expect(await call(fsHost, c, "read-text", { root: { tag: "granted", val: dropped.id }, path: "" })).toBe("user data");
			// another plugin cannot use it
			const other = fakeCtx(undefined, manifestOf({ id: "other@zinc.test" }));
			expect((await failure(call(fsHost, other, "read-text", { root: { tag: "granted", val: dropped.id }, path: "" })))?.tag).toBe("permission-denied");
			expect(asked).toEqual(["open", "directory", "save"]);
		} finally {
			setFilePicker(undefined);
		}
	});

	test("net.download writes into the data root, refuses a read-only destination and an existing file", async () => {
		const c = netCtx([base]);
		c.grants.netHosts.push(base);
		const opts = { reportProgress: false, onConflict: "fail", createParents: true, inactivityTimeoutMs: undefined };
		const done = await call(net, c, "download", request(`${base}/big?n=3000`), data("dl/file.bin"), opts);
		expect(done).toMatchObject({ file: data("dl/file.bin"), status: 200, bytes: 3000n });
		expect(readFileSync(join(root, "data", c.pluginId, "dl", "file.bin")).length).toBe(3000);
		expect(await failure(call(net, c, "download", request(`${base}/big?n=3000`), data("dl/file.bin"), opts))).toMatchObject({ tag: "other" });
		const unique = await call(net, c, "download", request(`${base}/big?n=10`), data("dl/file.bin"), { ...opts, onConflict: "rename-unique" });
		expect(unique.file).toEqual(data("dl/file 2.bin"));
		expect(await failure(call(net, c, "download", request(`${base}/big?n=10`), { root: { tag: "bundled" }, path: "x.bin" }, opts))).toMatchObject({ tag: "blocked" });
		expect(await failure(call(net, c, "download", request(`${base}/big?n=5000`, { maxResponseBytes: 100n }), data("dl/capped.bin"), opts))).toEqual({ tag: "too-large" });
		expect(existsSync(join(root, "data", c.pluginId, "dl", "capped.bin"))).toBe(false);
		expect(existsSync(join(root, "data", c.pluginId, "dl", "capped.bin.part"))).toBe(false);
	});
});

// ------------------------------------------------------------------------------ clipboard and shell
describe("shell", () => {
	test("URL validation: only http, https, mailto, and listed schemes; no file:, javascript:, data:; no spaces", () => {
		expect(checkOpenUrl("https://example.org/a?b=c", [])).toMatchObject({ scheme: "https", custom: false });
		expect(checkOpenUrl("mailto:a@b.org", [])).toMatchObject({ scheme: "mailto" });
		for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "data:text/html,x", "vbscript:x", "FILE:///x", "JaVaScRiPt:1", "https://a.org/x y", "https://a.org/\u0000", "calc.exe", "", "http://u:p@a.org/", "x".repeat(5000)]) {
			expect(() => checkOpenUrl(bad, ["obsidian"])).toThrow();
		}
		expect(() => checkOpenUrl("obsidian://open?vault=x", [])).toThrow(); // not listed
		expect(checkOpenUrl("obsidian://open?vault=x", ["obsidian"])).toMatchObject({ scheme: "obsidian", custom: true });
		expect(() => checkOpenUrl("zotero://select/items/1_ABC", ["zotero"])).not.toThrow();
		for (const f of ["a.exe", "b.BAT", "c.cmd", "d.ps1", "e.js", "f.lnk", "g.sh", "h.app", "i.msi", "j.jar", "k.vbs", "l.scr"]) expect(() => checkFileName(f)).toThrow();
		expect(() => checkFileName("paper.pdf")).not.toThrow();
	});

	test("open-url: permission, backend gets one validated argument, custom schemes need the user's confirmation", async () => {
		const opened: string[] = [];
		const confirms: string[] = [];
		setShellBackend({
			openUrl: async (u) => void opened.push(u),
			openFile: async (p) => void opened.push(`file:${p}`),
			reveal: async (p) => void opened.push(`reveal:${p}`),
			confirmScheme: async (_p, s) => (confirms.push(s), s === "obsidian"),
		});
		try {
			const none = fakeCtx(undefined, manifestOf({ shellSchemes: ["obsidian", "zotero"] }));
			expect((await failure(call(shell, none, "open-url", "https://example.org/")))?.tag).toBe("permission-denied");
			const c = fakeCtx(undefined, manifestOf({ capabilities: ["shell.open-url", "shell.open-file", "shell.reveal"], shellSchemes: ["obsidian", "zotero"] }));
			await call(shell, c, "open-url", "https://example.org/a");
			expect(opened).toEqual(["https://example.org/a"]);
			expect((await failure(call(shell, c, "open-url", "javascript:alert(1)")))?.tag).toBe("permission-denied");
			expect((await failure(call(shell, c, "open-url", "file:///C:/x")))?.tag).toBe("permission-denied");
			expect((await failure(call(shell, c, "open-url", "https://a.org/ ; calc")))?.tag).toBe("invalid-argument");
			await call(shell, c, "open-url", "obsidian://open?vault=v");
			await call(shell, c, "open-url", "obsidian://open?vault=w"); // the confirmation is per scheme, asked once
			expect((await failure(call(shell, c, "open-url", "zotero://select/x")))?.tag).toBe("permission-denied"); // user said no
			expect((await failure(call(shell, c, "open-url", "slack://x")))?.tag).toBe("permission-denied"); // not listed
			expect(confirms).toEqual(["obsidian", "zotero"]);
			expect(opened).toHaveLength(3);
			// files: only the plugin's own and granted files, never programs
			await call(fsHost, c, "write-text", data("open/doc.txt"), "x", WRITE);
			await call(fsHost, c, "write-text", data("open/run.bat"), "x", WRITE);
			await call(shell, c, "open-file", data("open/doc.txt"));
			expect(opened.at(-1)).toEndWith("doc.txt");
			expect((await failure(call(shell, c, "open-file", data("open/run.bat"))))?.tag).toBe("permission-denied");
			expect((await failure(call(shell, c, "open-file", { root: { tag: "bundled" }, path: "icon.txt" })))?.tag).toBe("permission-denied");
			expect((await failure(call(shell, c, "open-file", data("open/missing.txt"))))?.tag).toBe("not-found");
			await call(shell, c, "reveal", data("open/doc.txt"));
			expect(opened.at(-1)).toStartWith("reveal:");
		} finally {
			setShellBackend(undefined);
		}
	});
});

describe("clipboard", () => {
	test("write needs the permission and is rate limited; read needs focus and a first-use confirmation", async () => {
		const wrote: any[] = [];
		let focused = false;
		let confirms = 0;
		setClipboardBackend({ write: async (c) => void wrote.push(c), read: async () => ({ text: "clip" }), windowFocused: () => focused, confirmRead: async () => (confirms++, true) });
		try {
			const none = fakeCtx(undefined);
			expect((await failure(call(clipboard, none, "write", { text: "x" })))?.tag).toBe("permission-denied");
			const c = fakeCtx(undefined, manifestOf({ id: "clip@zinc.test", capabilities: ["clipboard.write", "clipboard.read"] }));
			await call(clipboard, c, "write", { text: "hello", html: "<b>hello</b>", imagePng: undefined });
			expect(wrote).toEqual([{ text: "hello", html: "<b>hello</b>", imagePng: undefined }]);
			let limited: any;
			for (let i = 0; i < 12 && !limited; i++) limited = await failure(call(clipboard, c, "write", { text: "x" }));
			expect(limited?.tag).toBe("limit-exceeded");
			expect((await failure(call(clipboard, c, "read")))?.tag).toBe("permission-denied"); // no focused window
			focused = true;
			expect((await call(clipboard, c, "read")).text).toBe("clip");
			await call(clipboard, c, "read");
			expect(confirms).toBe(1);
			expect((await failure(call(clipboard, fakeCtx(undefined, manifestOf({ id: "w@zinc.test", capabilities: ["clipboard.write"] })), "read")))?.tag).toBe("permission-denied");
			// the default backend denies a read (no confirmation)
			setClipboardBackend(undefined);
			const d = fakeCtx(undefined, manifestOf({ id: "d@zinc.test", capabilities: ["clipboard.read"] }));
			expect((await failure(call(clipboard, d, "read")))?.tag).toBe("permission-denied");
		} finally {
			setClipboardBackend(undefined);
		}
	});
});

// ---------------------------------------------------------------------------------------------- notifier
const sub = (over: Record<string, unknown> = {}) => ({ types: [], kinds: [], priority: 100, skipOwn: false, maxDelayMs: 10, label: "t", ...over });
const row = (seq: number, object: string, kind: string, key: string, origin = "unknown", silent = false) => ({ seq, object, kind, key, library: 1, origin, silent });

describe("notifier hub", () => {
	test("merges ids per (object, kind) into one batch, in order, with seq counting up", async () => {
		const hub = new NotifierHub({ baseUrl: "http://127.0.0.1:1" });
		const got: WitBatch[] = [];
		hub.subscribe("a@x.org", sub(), async (_id, b) => void got.push(b));
		hub.handle({ head: 5, cursor: 5, reset: false, changes: [row(1, "item", "add", "K1"), row(2, "item", "add", "K2"), row(3, "item-tag", "add", "K1-t"), row(4, "item", "add", "K3"), row(5, "item", "modify", "K1")] });
		await until(() => got.length === 1, 1000, "a batch");
		expect(got[0].seq).toBe(1n);
		expect(got[0].events.map((e) => [e.object, e.kind, e.ids])).toEqual([
			["item", "add", ["K1", "K2", "K3"]],
			["item-tag", "add", ["K1-t"]],
			["item", "modify", ["K1"]],
		]);
		hub.handle({ head: 6, cursor: 6, reset: false, changes: [row(6, "collection", "add", "C1")] });
		await until(() => got.length === 2, 1000, "second batch");
		expect(got[1].seq).toBe(2n);
		hub.stop();
	});

	test("filters: types, kinds, skip-own, silent rows, origin mapping; priority orders subscriptions", async () => {
		const hub = new NotifierHub({ baseUrl: "http://127.0.0.1:1" });
		const order: string[] = [];
		const a: WitBatch[] = [];
		const b: WitBatch[] = [];
		hub.subscribe("a@x.org", sub({ types: ["item"], kinds: ["add"], skipOwn: true, priority: 50 }), async (_i, x) => (order.push("a"), void a.push(x)));
		hub.subscribe("b@x.org", sub({ priority: 10 }), async (_i, x) => (order.push("b"), void b.push(x)));
		hub.handle({
			head: 6,
			cursor: 6,
			reset: false,
			changes: [row(1, "item", "add", "K1", "plugin:a@x.org"), row(2, "item", "add", "K2", "plugin:b@x.org"), row(3, "item", "modify", "K3"), row(4, "collection", "add", "C1"), row(5, "item", "add", "K5", "user", true), row(6, "item", "add", "K6", "sync")],
		});
		await until(() => a.length === 1 && b.length === 1, 1000, "both batches");
		expect(order).toEqual(["b", "a"]);
		expect(a[0].events.map((e) => [e.ids, e.origin])).toEqual([[["K2"], { tag: "plugin", val: "b@x.org" }], [["K6"], { tag: "sync" }]]);
		expect(b[0].events.find((e) => e.ids.includes("K1"))!.origin).toEqual({ tag: "plugin", val: "a@x.org" });
		expect(b[0].events.flatMap((e) => e.ids)).not.toContain("K5"); // silent
		hub.stop();
	});

	test("one batch in flight per subscription; overflow keeps 256 and adds refresh events", async () => {
		const hub = new NotifierHub({ baseUrl: "http://127.0.0.1:1" });
		const got: WitBatch[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let inflight = 0;
		let maxInflight = 0;
		hub.subscribe("slow@x.org", sub({ maxDelayMs: 1 }), async (_i, b) => {
			maxInflight = Math.max(maxInflight, ++inflight);
			await gate;
			got.push(b);
			inflight--;
		});
		for (let i = 1; i <= QUEUE_LIMIT + 40; i++) {
			hub.handle({ head: i, cursor: i, reset: false, changes: [row(i, "item", "add", `K${i}`)] });
			await wait(2); // one flush each
		}
		release();
		await until(() => got.length >= QUEUE_LIMIT, 3000, "the queue to drain");
		await wait(50);
		expect(maxInflight).toBe(1);
		const refresh = got.flatMap((b) => b.events).filter((e) => e.kind === "refresh");
		expect(refresh.length).toBeGreaterThan(0);
		expect(refresh[0].object).toBe("item");
		expect(got.length).toBeLessThanOrEqual(QUEUE_LIMIT + 2);
		hub.stop();
	});

	test("a reset becomes refresh events; plugin-defined `other` events reach other subscribers", async () => {
		const hub = new NotifierHub({ baseUrl: "http://127.0.0.1:1" });
		const got: WitBatch[] = [];
		hub.subscribe("a@x.org", sub({ types: ["item", "collection"] }), async (_i, b) => void got.push(b));
		hub.handle({ head: 0, cursor: 0, reset: true, changes: [] });
		await until(() => got.length === 1, 1000, "refresh");
		expect(got[0].events.map((e) => [e.object, e.kind, e.ids])).toEqual([["item", "refresh", []], ["collection", "refresh", []]]);
		hub.trigger("p@x.org", { object: "item", ids: ["K1"], options: JSON.stringify({ name: "my-event" }) });
		await until(() => got.length === 2, 1000, "other event");
		expect(got[1].events[0]).toMatchObject({ object: "item", kind: "other", ids: ["K1"], origin: { tag: "plugin", val: "p@x.org" } });
		expect(hub.unsubscribe("nobody", 1)).toBe(false);
		hub.dropPlugin("a@x.org");
		expect(hub.size).toBe(0);
	});
});

describe("notifier handler against a core", () => {
	let core: TestCore;
	beforeAll(async () => {
		core = await startCore();
	});
	afterAll(() => {
		resetNotifier();
		core.stop();
	});

	test("subscribe needs library.read; a write to core arrives as one batch through on-events", async () => {
		const calls: unknown[][] = [];
		const m = manifestOf({ capabilities: ["library.read"] });
		const ctx = fakeCtx(core, m, { calls });
		expect((await failure(call(notifier, fakeCtx(core), "subscribe", sub())))?.tag).toBe("permission-denied");
		const id = await call(notifier, ctx, "subscribe", sub({ types: ["item", "item-tag"], maxDelayMs: 30 }));
		expect(typeof id).toBe("number");
		await wait(300); // the feed reads the head first
		const post = (path: string, body: unknown) => fetch(core.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const r = await (await post("/api/items", { data: { itemType: "book", title: "Notify me", tags: [{ tag: "n" }] } })).json();
		await until(() => calls.length > 0, 5000, "on-events");
		const [iface, fn, subId, batch] = calls[0] as [string, string, number, WitBatch];
		expect([iface, fn, subId]).toEqual(["notifier-handler", "on-events", id]);
		const kinds = batch.events.map((e) => `${e.object}:${e.kind}`);
		expect(kinds).toContain("item:add");
		expect(kinds).toContain("item-tag:add");
		expect(batch.events.find((e) => e.object === "item")!.ids).toContain(r.data.key);
		expect(batch.events.every((e) => e.object === "item" || e.object === "item-tag")).toBe(true);
		await call(notifier, ctx, "unsubscribe", id);
		expect((await failure(call(notifier, ctx, "unsubscribe", id)))?.tag).toBe("not-found");
		// trigger: only `other`, with a name
		expect((await failure(call(notifier, ctx, "trigger", { object: "item", kind: "add", ids: ["K"], options: undefined })))?.tag).toBe("invalid-argument");
		expect((await failure(call(notifier, ctx, "trigger", { object: "item", kind: "other", ids: ["K"], options: undefined })))?.tag).toBe("invalid-argument");
		await call(notifier, ctx, "trigger", { object: "item", kind: "other", ids: ["K"], options: JSON.stringify({ name: "x" }) });
	});
});
