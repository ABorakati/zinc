// The reader tab's data path in the Zinc Connector extension (web/build.ts copies reader-host into library/reader/ and loads this
// first). reader-host/src/host.js sends every /api request through globalThis.znApiFetch when it exists; here that is the same
// native-messaging transport the library tab uses (web/native-host.ts, method "api"), so the reader reads the file and saves
// annotations through the connector's host. ?host=<name> picks another registration of the host (the headless check registers
// its own); anything that does not look like a Zinc host name falls back to the default.
import { HOST_NAME, nativeApiTransport, type NativePort } from "../native-host";

declare const chrome: {
	runtime: { connectNative(name: string): NativePort; lastError?: { message?: string } };
};

const param = new URLSearchParams(location.search).get("host");
const hostName = param && /^com\.zotero_next\.[a-z0-9_.]+$/.test(param) ? param : HOST_NAME;
const transport = nativeApiTransport(() => chrome.runtime.connectNative(hostName), () => chrome.runtime.lastError?.message);

(globalThis as Record<string, unknown>).znApiFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
	transport(new Request(new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href), init));
