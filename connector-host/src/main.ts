// Entry point of the compiled "zotero-next host" (bun build --compile). Chrome starts it for
// chrome.runtime.connectNative(); stdin/stdout carry the native-messaging frames, so nothing else may print there.
import { runHost } from "./host";

// stdout is the protocol channel: route every log to stderr.
console.log = console.error;
console.info = console.error;

const write = (b: Buffer) => void process.stdout.write(b);

try {
	await runHost(Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>, write);
} catch (e) {
	console.error("[host] fatal:", e);
	process.exitCode = 1;
}
// Chrome closed the pipe: leave even if a library handle keeps the loop alive.
process.exit(process.exitCode ?? 0);
