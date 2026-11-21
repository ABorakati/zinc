// A client for the richtext-core `pm_bridge` example: one process, JSON lines in and out. A call that fails or times out restarts it.
import type { Subprocess } from "bun";

export interface BridgeReply {
	doc?: unknown;
	trace?: string[];
	error?: string;
}

export class Bridge {
	private proc!: Subprocess<"pipe", "pipe", "pipe">;
	private waiting: { resolve: (r: BridgeReply) => void; reject: (e: Error) => void }[] = [];
	private buf = "";
	/** stderr of the bridge since the last call (panic messages) */
	stderr = "";
	restarts = 0;

	constructor(
		private bin: string,
		private timeoutMs = 30_000,
	) {
		this.start();
	}

	private start() {
		const proc = Bun.spawn([this.bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.proc = proc;
		this.buf = "";
		void (async () => {
			const dec = new TextDecoder();
			for await (const chunk of proc.stdout) {
				if (this.proc !== proc) return;
				this.buf += dec.decode(chunk, { stream: true });
				let i: number;
				while ((i = this.buf.indexOf("\n")) >= 0) {
					const line = this.buf.slice(0, i);
					this.buf = this.buf.slice(i + 1);
					const w = this.waiting.shift();
					if (!w) continue;
					try {
						w.resolve(JSON.parse(line) as BridgeReply);
					} catch (e) {
						w.reject(new Error(`bad bridge line: ${line.slice(0, 200)}`));
					}
				}
			}
			if (this.proc === proc) for (const w of this.waiting.splice(0)) w.reject(new Error("bridge exited"));
		})();
		void (async () => {
			const dec = new TextDecoder();
			for await (const chunk of proc.stderr) this.stderr = (this.stderr + dec.decode(chunk, { stream: true })).slice(-4000);
		})();
	}

	async call(req: Record<string, unknown>): Promise<BridgeReply> {
		this.stderr = "";
		const line = JSON.stringify(req) + "\n";
		try {
			const reply = new Promise<BridgeReply>((resolve, reject) => {
				this.waiting.push({ resolve, reject });
				this.proc.stdin.write(line);
				void this.proc.stdin.flush();
			});
			let timer: ReturnType<typeof setTimeout>;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`bridge timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
			});
			try {
				return await Promise.race([reply, timeout]);
			} finally {
				clearTimeout(timer!);
			}
		} catch (e) {
			this.proc.kill();
			this.waiting.length = 0;
			this.restarts++;
			this.start();
			throw e;
		}
	}

	close() {
		this.proc.kill();
	}
}
