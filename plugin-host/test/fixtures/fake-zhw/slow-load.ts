// A stand-in for `zhw` whose loads take 1.5 s. Everything else is answered at once.
const out = (v: unknown) => console.log(JSON.stringify(v));
out({ t: "ready", pid: process.pid, interfaces: [] });
setInterval(() => out({ t: "heartbeat", ts: Date.now() }), 300);
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl: number;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, nl));
		buf = buf.slice(nl + 1);
		if (m.id === undefined) continue;
		setTimeout(() => out({ t: "reply", id: m.id, result: { ok: true, value: m.t === "load" ? {} : null } }), m.t === "load" ? 1500 : 0);
	}
}
process.exit(0); // stdin closed: whoever started this is gone (the heartbeat would keep it alive for ever)
