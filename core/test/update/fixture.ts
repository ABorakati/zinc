// Shared by e2e.test.ts and exit-fixture.ts: a local Bun.serve update feed (signed manifest + stub installer) and the stub installer.
// Loopback only; nothing leaves the machine.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { generateKeyPair, signManifest, type KeyPair, type Manifest } from "../../src/update/manifest";

/**
 * A .cmd that writes its own arguments and path to %ZN_STUB_MARKER% (the stand-in for the real silent installer), padded with comment
 * lines so the download is a few hundred KB (several chunks, a meaningful Range resume). `tag` makes each stub unique.
 */
export function stubInstaller(tag: string): Uint8Array {
	const head = [
		"@echo off",
		`>"%ZN_STUB_MARKER%" echo ARGS=%*`,
		`>>"%ZN_STUB_MARKER%" echo FILE=%~f0`,
		`>>"%ZN_STUB_MARKER%" echo TAG=${tag}`,
		"exit /b 0",
	];
	const pad = Array.from({ length: 6000 }, (_, i) => `REM padding line ${i} ${"x".repeat(40)}`);
	return new TextEncoder().encode([...head, ...pad].join("\r\n") + "\r\n");
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface Feed {
	url: string;
	installerUrl: string;
	manifest: Manifest;
	keys: KeyPair;
	/** Requests seen, in order: "GET /latest.json", "GET /files/... range=bytes=1000-". */
	requests: string[];
	/** Serve different installer bytes than the manifest describes (a tampered download). */
	tamperInstaller: boolean;
	/** Serve this text as the manifest instead (a tampered/forged manifest). */
	manifestOverride?: string;
	stop(): void;
}

export async function startFeed(o: {
	version: string;
	installer: Uint8Array;
	notes?: string;
	keys?: KeyPair;
	minVersion?: string;
}): Promise<Feed> {
	const keys = o.keys ?? (await generateKeyPair());
	const requests: string[] = [];
	const state = { tamperInstaller: false, manifestOverride: undefined as string | undefined };
	let base = "";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			const range = req.headers.get("range");
			requests.push(`GET ${url.pathname}${range ? ` range=${range}` : ""}`);
			if (url.pathname === "/latest.json")
				return new Response(state.manifestOverride ?? JSON.stringify(manifest), {
					headers: { "content-type": "application/json" },
				});
			if (url.pathname === "/files/setup.cmd") {
				let body = o.installer;
				if (state.tamperInstaller) {
					body = body.slice();
					body[body.length - 3] = body[body.length - 3]! ^ 0x20;
				}
				const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
				if (m) {
					const start = Number(m[1]);
					if (start >= body.length) return new Response(null, { status: 416 });
					return new Response(body.slice(start) as Uint8Array<ArrayBuffer>, {
						status: 206,
						headers: {
							"content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
							"content-length": String(body.length - start),
						},
					});
				}
				return new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-length": String(body.length) } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	const installerUrl = `${base}/files/setup.cmd`;
	const manifest = await signManifest(
		{
			version: o.version,
			releasedAt: "2026-12-01T09:00:00Z",
			notes: o.notes ?? "# What's new\n- Auto-update",
			url: installerUrl,
			sha256: sha256(o.installer),
			size: o.installer.length,
			...(o.minVersion ? { minVersion: o.minVersion } : {}),
		},
		keys.privateJwk,
	);
	return Object.assign(state, {
		url: `${base}/latest.json`,
		installerUrl,
		manifest,
		keys,
		requests,
		stop: () => void server.stop(true),
	}) as unknown as Feed;
}

/** A scratch folder (ZN_E2E_OUT, else under the system temp) with a sub-folder per test. */
export function scratch(root: string, name: string): string {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	return d;
}
export { writeFileSync };
