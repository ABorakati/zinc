// A stand-in for `zhw` that starts, sends heartbeats and never answers a request. For tests of the supervisor's control-request limits.
console.log(JSON.stringify({ t: "ready", pid: process.pid, interfaces: [] }));
setInterval(() => console.log(JSON.stringify({ t: "heartbeat", ts: Date.now() })), 300);
for await (const _ of Bun.stdin.stream()) {
	// ignore every request
}
process.exit(0); // stdin closed: whoever started this is gone (the heartbeat would keep it alive for ever)
