// Test-side client for oracle-child.ts: asks Zotero's own vendored utilities for the "expected" answer.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "oracle-child.ts");

export interface Oracle {
	/** Run `op` with `args` inside Zotero's code. Rejects with the message Zotero threw. */
	call<T = any>(op: string, ...args: unknown[]): Promise<T>;
	close(): void;
}

export function startOracle(): Oracle {
	const proc = Bun.spawn([process.execPath, CHILD], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
	let seq = 0;
	(async () => {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const r = JSON.parse(line);
				const p = pending.get(r.id);
				pending.delete(r.id);
				if (r.ok) p?.ok(r.value);
				else p?.fail(new Error(r.error));
			}
		}
		for (const p of pending.values()) p.fail(new Error("oracle exited"));
	})();
	return {
		call(op, ...args) {
			const id = ++seq;
			return new Promise((ok, fail) => {
				pending.set(id, { ok, fail });
				proc.stdin.write(JSON.stringify({ id, op, args }) + "\n");
				proc.stdin.flush();
			});
		},
		close() {
			proc.stdin.end();
			proc.kill();
		},
	};
}
