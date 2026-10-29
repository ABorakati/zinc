import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { buildFixture, PDF_BYTES, tempDir } from "./fixture";

let srv: ReturnType<typeof startServer>;
let base: string;

beforeAll(() => {
	const fx = buildFixture();
	fx.db.close();
	const app = tempDir();
	mkdirSync(join(app, "sub"));
	writeFileSync(join(app, "index.html"), "<h1>app</h1>");
	writeFileSync(join(app, "sub", "index.html"), "<h1>sub</h1>");
	writeFileSync(join(app, "w.wasm"), "\0asm");
	writeFileSync(join(app, "x.mjs"), "export {}");
	writeFileSync(join(app, "m.ftl"), "a = b");
	writeFileSync(join(app, "c.bcmap"), "bc");
	writeFileSync(join(app, "model.onnx"), "onnx");
	const reader = tempDir();
	writeFileSync(join(reader, "index.html"), "<h1>reader</h1>");
	writeFileSync(join(tempDir(), "secret.txt"), "secret");
	writeFileSync(join(app, "..", "zn-secret.txt"), "secret");
	srv = startServer({
		dbPath: join(fx.dir, "lib.sqlite"),
		port: 0,
		mounts: [
			{ prefix: "/app/", dir: app },
			{ prefix: "/app/reader/", dir: reader },
		],
	});
	base = srv.url;
});
afterAll(() => srv.stop());

describe("server", () => {
	test("api rejects cross-site and non-loopback requests", async () => {
		const post = (headers: Record<string, string>, body: string | undefined = JSON.stringify({ name: "x" })) =>
			fetch(`${base}/api/collections`, { method: "POST", headers, body });
		// Same-origin JSON (what the app's pages send) is allowed; clean up what it creates.
		const allowed: Record<string, string>[] = [{ "Content-Type": "application/json", Origin: base }, { "Content-Type": "application/json" }];
		for (const headers of allowed) {
			const ok = await post(headers);
			expect(ok.status).toBe(201);
			const { key } = (await ok.json()) as { key: string };
			const del = await fetch(`${base}/api/collections/${key}`, { method: "DELETE" });
			expect(del.status).toBe(200);
		}
		// Another site's page, a form-style body, or a rebinding Host are refused.
		expect((await post({ "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
		expect((await post({ "Content-Type": "text/plain" })).status).toBe(403);
		expect((await post({ "Content-Type": "application/x-www-form-urlencoded" }, "name=x")).status).toBe(403);
		const rebound = await fetch(`${base}/api/collections`, { headers: { Host: "evil.example" } });
		expect(rebound.status).toBe(403);
		// Reads and bodiless actions from the app still work.
		expect((await fetch(`${base}/api/collections`)).status).toBe(200);
	});
	test("api through server", async () => {
		const r = await fetch(`${base}/api/collections`);
		expect(r.status).toBe(200);
		expect(((await r.json()) as any[]).length).toBe(2);
	});
	test("pdf range over HTTP", async () => {
		const r = await fetch(`${base}/api/attachments/ATT00002/file`, { headers: { Range: "bytes=10-19" } });
		expect(r.status).toBe(206);
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES.slice(10, 20));
	});
	test("static index and longest prefix", async () => {
		expect(await (await fetch(`${base}/app/`)).text()).toBe("<h1>app</h1>");
		expect(await (await fetch(`${base}/app/sub/`)).text()).toBe("<h1>sub</h1>");
		expect(await (await fetch(`${base}/app/reader/`)).text()).toBe("<h1>reader</h1>");
		expect(await (await fetch(`${base}/app/reader/index.html`)).text()).toBe("<h1>reader</h1>");
	});
	test("redirect without trailing slash", async () => {
		const r = await fetch(`${base}/app`, { redirect: "manual" });
		expect(r.status).toBe(302);
		expect(r.headers.get("location")).toBe("/app/");
	});
	test("mime types", async () => {
		const ct = async (p: string) => (await fetch(`${base}/app/${p}`)).headers.get("content-type");
		expect(await ct("w.wasm")).toBe("application/wasm");
		expect(await ct("x.mjs")).toStartWith("text/javascript");
		expect(await ct("m.ftl")).toStartWith("text/plain");
		expect(await ct("c.bcmap")).toBe("application/octet-stream");
		expect(await ct("model.onnx")).toBe("application/octet-stream");
		expect(await ct("index.html")).toStartWith("text/html");
	});
	test("path traversal blocked", async () => {
		for (const p of ["/app/..%2fzn-secret.txt", "/app/%2e%2e/zn-secret.txt", "/app/..%5czn-secret.txt", "/app/%00"]) {
			const r = await fetch(`${base}${p}`);
			expect(r.status).not.toBe(200);
		}
		// raw (non-normalised) request path
		const raw = await new Promise<string>((resolve) => {
			const url = new URL(base);
			Bun.connect({
				hostname: url.hostname,
				port: Number(url.port),
				socket: {
					open(s) {
						s.write("GET /app/../zn-secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
					},
					data(_s, d) {
						resolve(Buffer.from(d).toString());
					},
					error() {
						resolve("");
					},
				},
			});
		});
		expect(raw).not.toContain("secret");
	});
	test("404", async () => {
		expect((await fetch(`${base}/nothing`)).status).toBe(404);
		expect((await fetch(`${base}/app/missing.js`)).status).toBe(404);
	});
});
