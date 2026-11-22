import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST_ENV, OFFICE_JS_URL } from "../../build";
import { CERT_DIR_ENV, createFetchHandler, startServer } from "../../serve";

const officejsDir = join(import.meta.dir, "..", "..");

describe("build.ts and serve.ts", () => {
	test("build.ts builds taskpane.html, main.js, style.css and icons into ZN_OFFICEJS_DIST temp dir", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "zinc-officejs-dist-"));
		const proc = Bun.spawnSync([process.execPath, "build.ts"], {
			cwd: officejsDir,
			env: { ...process.env, [DIST_ENV]: outDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(0);

		const htmlPath = join(outDir, "taskpane.html");
		const bundlePath = join(outDir, "main.js");
		const cssPath = join(outDir, "style.css");

		expect(existsSync(htmlPath)).toBe(true);
		expect(existsSync(bundlePath)).toBe(true);
		expect(existsSync(cssPath)).toBe(true);
		for (const size of [16, 32, 64, 80]) {
			expect(existsSync(join(outDir, `icon-${size}.png`))).toBe(true);
		}

		const html = readFileSync(htmlPath, "utf8");
		const officeIdx = html.indexOf(OFFICE_JS_URL);
		const bundleIdx = html.indexOf('src="main.js"');
		expect(officeIdx).toBeGreaterThan(-1);
		expect(bundleIdx).toBeGreaterThan(officeIdx);
		expect(html).toContain('href="style.css"');
		expect(html).toContain('id="app"');
		expect(html).toContain('id="q"');

		const bundle = readFileSync(bundlePath, "utf8");
		expect(bundle.length).toBeGreaterThan(1000);
		expect(bundle).toContain("__znHost");

		// Verify serve.ts static handler over loopback 127.0.0.1 with Cache-Control: no-store
		const srv = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: createFetchHandler(outDir),
		});
		try {
			const base = `http://127.0.0.1:${srv.port}`;
			const rootRes = await fetch(`${base}/`);
			expect(rootRes.status).toBe(200);
			expect(rootRes.headers.get("Cache-Control")).toBe("no-store");
			expect(await rootRes.text()).toBe(html);

			const taskpaneRes = await fetch(`${base}/taskpane.html`);
			expect(taskpaneRes.status).toBe(200);
			expect(taskpaneRes.headers.get("Cache-Control")).toBe("no-store");

			const jsRes = await fetch(`${base}/main.js`);
			expect(jsRes.status).toBe(200);
			expect(jsRes.headers.get("Cache-Control")).toBe("no-store");

			const iconRes = await fetch(`${base}/icon-32.png`);
			expect(iconRes.status).toBe(200);
			expect(iconRes.headers.get("Cache-Control")).toBe("no-store");

			const missRes = await fetch(`${base}/missing.txt`);
			expect(missRes.status).toBe(404);
			expect(missRes.headers.get("Cache-Control")).toBe("no-store");

			const traversalRes = await fetch(`${base}/..%2Fmanifest%2Fmanifest.xml`);
			expect(traversalRes.status).toBe(404);
			expect(traversalRes.headers.get("Cache-Control")).toBe("no-store");
		} finally {
			srv.stop(true);
		}
	});

	test("serve.ts does not crash when localhost.crt / localhost.key are missing and explains how to create them", () => {
		const emptyCertDir = mkdtempSync(join(tmpdir(), "zinc-officejs-nocert-"));
		const direct = startServer({ certDir: emptyCertDir, port: 0 });
		expect(direct.started).toBe(false);
		expect(direct.message).toContain("localhost.crt");
		expect(direct.message).toContain("office-addin-dev-certs");

		const proc = Bun.spawnSync([process.execPath, "serve.ts"], {
			cwd: officejsDir,
			env: { ...process.env, [CERT_DIR_ENV]: emptyCertDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(0);
		const stdout = proc.stdout.toString();
		expect(stdout).toContain("localhost.crt");
		expect(stdout).toContain("office-addin-dev-certs");
	});
});
