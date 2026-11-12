// The extension page's transport (web/native-host.ts) against a fake port that answers like connector-host (res + rc chunks).
import { expect, test } from "bun:test";
import { nativeApiTransport, type NativePort } from "./native-host";

function fakeHost(answer: (req: any, uploads: Map<string, string[]>) => { status: number; body: Uint8Array; headers?: Record<string, string> }) {
	const sent: any[] = [];
	let onMsg: (m: any) => void = () => {};
	let onDisc: () => void = () => {};
	let connects = 0;
	const uploads = new Map<string, string[]>();
	const port: NativePort = {
		postMessage(m: any) {
			sent.push(m);
			if (m.t === "up") { uploads.set(m.uid, [...(uploads.get(m.uid) ?? []), m.data]); return; }
			if (m.t !== "req") return;
			const a = answer(m, uploads);
			const CH = 600_000;
			const n = Math.ceil(a.body.length / CH);
			queueMicrotask(() => {
				onMsg({ t: "res", id: m.id, status: a.status, headers: a.headers ?? { "content-type": "application/json" }, n });
				// chunks out of order: the transport must put them back by seq
				for (let i = n - 1; i >= 0; i--) onMsg({ t: "rc", id: m.id, seq: i, data: Buffer.from(a.body.subarray(i * CH, (i + 1) * CH)).toString("base64") });
			});
		},
		onMessage: { addListener: (f) => { onMsg = f; } },
		onDisconnect: { addListener: (f) => { onDisc = f; } },
	};
	return { sent, uploads, connect: () => { connects++; return port; }, disconnect: () => onDisc(), connects: () => connects };
}

test("a GET becomes an api frame, and a multi-chunk answer is reassembled", async () => {
	const big = new Uint8Array(1_500_000).map((_, i) => i & 0xff);
	const h = fakeHost(() => ({ status: 200, body: big, headers: { "content-type": "application/pdf" } }));
	const fetchNative = nativeApiTransport(h.connect);
	const res = await fetchNative(new Request("http://127.0.0.1/api/attachments/ABCD1234/file?x=1"));
	expect(h.sent[0]).toMatchObject({ t: "req", method: "api", http: "GET", path: "/api/attachments/ABCD1234/file?x=1" });
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("application/pdf");
	expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), Buffer.from(big))).toBe(0);
});

test("small JSON bodies go inline; large ones as up frames", async () => {
	const h = fakeHost((req, uploads) => {
		const text = req.body?.kind === "upload" ? Buffer.concat(uploads.get(req.body.uid)!.map((d) => Buffer.from(d, "base64"))).toString() : req.body?.text;
		return { status: 200, body: new TextEncoder().encode(JSON.stringify({ len: text.length })) };
	});
	const fetchNative = nativeApiTransport(h.connect);
	const small = await fetchNative(new Request("http://127.0.0.1/api/ui/selection", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"kind":"library"}' }));
	expect(await small.json()).toEqual({ len: 18 });
	expect(h.sent.at(-1).body.kind).toBe("text");
	const long = JSON.stringify({ note: "x".repeat(3_000_000) });
	const large = await fetchNative(new Request("http://127.0.0.1/api/items/ABCD1234", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: long }));
	expect(await large.json()).toEqual({ len: long.length });
	expect(h.sent.filter((m) => m.t === "up").length).toBe(3);
});

test("a host that goes away fails the calls in flight, and the next call reconnects", async () => {
	let hold = true;
	const h = fakeHost(() => ({ status: 204, body: new Uint8Array() }));
	const base = h.connect;
	const fetchNative = nativeApiTransport(() => {
		const p = base();
		const post = p.postMessage.bind(p);
		return { ...p, postMessage: (m: any) => { if (!hold) post(m); } };
	}, () => "Native host has exited.");
	const inFlight = fetchNative(new Request("http://127.0.0.1/api/items"));
	await Bun.sleep(5);
	h.disconnect();
	await expect(inFlight).rejects.toThrow(/stopped/);
	hold = false;
	const next = await fetchNative(new Request("http://127.0.0.1/api/items"));
	expect(next.status).toBe(204);
	expect(h.connects()).toBe(2);
});

test("resolveHostName: an explicit ?host= is used; without one a test extension never gets the real name", async () => {
	const { resolveHostName, HOST_NAME } = await import("./native-host");
	expect(resolveHostName("?host=com.zotero_next.connector_host_e2e_x", true)).toBe("com.zotero_next.connector_host_e2e_x");
	expect(resolveHostName("?host=com.zotero_next.connector_host_e2e_x", false)).toBe("com.zotero_next.connector_host_e2e_x");
	expect(resolveHostName("", false)).toBe(HOST_NAME);
	expect(resolveHostName("", true)).not.toBe(HOST_NAME);
	expect(resolveHostName("?host=evil.example", true)).not.toBe(HOST_NAME);
	expect(resolveHostName("?host=evil.example", false)).toBe(HOST_NAME);
});
