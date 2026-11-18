// Probe for test/prelude.built.test.ts: each on-locale-changed(name) runs one probe and logs `RESULT name = <json>`.
import { definePlugin } from "../../../../src/index.ts";
import log from "zinc:plugin/log@0.1.0";

class MyDate extends Date {
	year() { return this.getUTCFullYear(); }
}
const timeouts = [];
const P = {
	dateNow: () => Date.now(),
	newDate: () => new Date().getTime(),
	dateCall: () => typeof Date(),
	dateInstance: () => [new Date() instanceof Date, Object.prototype.toString.call(new Date()), new Date().constructor === Date],
	dateSubclass: () => { const d = new MyDate(); return [d instanceof MyDate, d instanceof Date, d.year()]; },
	dateWithArgs: () => [new Date(1700000000000).toISOString(), new Date("2024-03-05T10:00:00Z").getTime(), new Date(2024, 2, 5).getTime(), Date.parse("2024-03-05T10:00:00Z"), Date.UTC(2024, 2, 5), Number.isNaN(new Date(undefined).getTime())],
	dateArith: () => new Date().getFullYear() - new Date(0).getFullYear(),
	dateJson: () => JSON.stringify({ d: new Date() }).length,
	perfNow: () => { const a = performance.now(); const b = performance.now(); return [a, b]; },
	consoleAll: () => { console.log("a", { b: 1 }); console.info("i"); console.warn("w"); console.error(new Error("boom").message); console.debug("d"); return typeof console.assert; },
	encode: () => Array.from(new TextEncoder().encode("hé€😀")),
	decode: () => new TextDecoder().decode(new TextEncoder().encode("hé€😀 ok")),
	decodeBad: () => new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x82])),
	timeoutSet: () => {
		timeouts.push(setTimeout((a, b) => log.write("info", "FIRED " + a + b), 50, "x", "y"));
		timeouts.push(setInterval(() => log.write("info", "TICK"), 10));
		return timeouts;
	},
	timeoutClear: () => { clearInterval(timeouts[1]); return "cleared"; },
	types: () => [typeof setTimeout, typeof clearTimeout, typeof setInterval, typeof clearInterval, typeof console, typeof TextEncoder, typeof TextDecoder, typeof performance.now],
};
export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents, mcpHandler } = definePlugin({
	events: {
		onLocaleChanged(name) {
			log.write("info", "BEGIN " + name);
			try { log.write("info", "RESULT " + name + " = " + JSON.stringify(P[name]())); } catch (e) { log.write("info", "THROW " + name + " " + e); }
		},
		onTimer(id, kind) { log.write("info", "OWN-TIMER " + id + " " + kind); },
	},
});
