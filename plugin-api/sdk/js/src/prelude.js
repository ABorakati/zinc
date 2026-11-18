// Globals a QuickJS guest lacks or cannot use. build.ts prepends this file to every JS plugin (the `export` keywords are stripped
// and a call to installPrelude() with the `timers` and `log` imports is added); tests call it on a sandbox object.
//
// QuickJS in componentize-qjs has no clock: Date.now(), new Date() and performance.now() end in `wasm unreachable`, and the guest has
// no console, setTimeout, TextEncoder or URL. Nothing here runs a Date/clock call at install time (the wizer snapshot is taken
// after top-level code, and a clock call there would be frozen). Each polyfill is skipped when the global is already usable.

export function installPrelude(g, host) {
	const { timers, log } = host;
	const now = () => Number(timers.now());

	// ---- Date: argument-less construction, Date() and Date.now() read timers.now() ----
	// A Proxy keeps `instanceof`, subclassing, Date.parse/UTC, name and length of the real constructor.
	const NativeDate = g.Date;
	if (!NativeDate.__zinc) {
		const ZDate = new Proxy(NativeDate, {
			construct: (t, args, nt) => Reflect.construct(t, args.length === 0 ? [now()] : args, nt),
			apply: (t) => new t(now()).toString(),
			get: (t, p, r) => (p === "now" ? now : p === "__zinc" ? true : Reflect.get(t, p, r)),
		});
		NativeDate.prototype.constructor = ZDate;
		g.Date = ZDate;
	}

	// ---- performance.now(): monotonic clock, ms since first use ----
	let t0;
	const perfNow = () => {
		const t = Number(timers.monotonicMs());
		return t - (t0 ??= t);
	};
	const perf = g.performance ?? {};
	try {
		Object.defineProperty(perf, "now", { value: perfNow, writable: true, configurable: true }); // `now` is read-only in QuickJS
		if (perf.timeOrigin === undefined) Object.defineProperty(perf, "timeOrigin", { get: () => now() - perfNow(), configurable: true });
		g.performance = perf;
	} catch {
		// not configurable: put a replacement object on the global
		Object.defineProperty(g, "performance", { value: { now: perfNow, get timeOrigin() { return now() - perfNow(); } }, writable: true, configurable: true });
	}

	// ---- console ----
	if (typeof g.console === "undefined") {
		const fmt = (a) => {
			if (typeof a === "string") return a;
			if (a instanceof Error) return a.stack ? `${a.name}: ${a.message}\n${a.stack}` : String(a);
			if (a && typeof a === "object") {
				try { return JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}n` : v)); } catch { return String(a); }
			}
			return String(a);
		};
		const out = (level) => (...a) => {
			try { log.write(level, a.map(fmt).join(" ")); } catch {}
		};
		g.console = {
			log: out("info"), info: out("info"), warn: out("warn"), error: out("error"), debug: out("debug"), trace: out("debug"),
			assert: (c, ...a) => { if (!c) out("error")("Assertion failed:", ...a); },
		};
	}

	// ---- setTimeout / setInterval over timers.set-timeout / set-interval; definePlugin routes events.on-timer to __zincTimerFire ----
	if (typeof g.setTimeout === "undefined") {
		const live = new Map(); // host timer id -> { fn, args }
		const delay = (ms) => { ms = Math.floor(Number(ms)); return ms > 0 ? Math.min(ms, 0xffffffff) : 0; };
		g.setTimeout = (fn, ms, ...args) => { const id = timers.setTimeout(delay(ms)); live.set(id, { fn, args }); return id; };
		g.setInterval = (fn, ms, ...args) => { const id = timers.setInterval(delay(ms)); live.set(id, { fn, args }); return id; };
		g.clearTimeout = g.clearInterval = (id) => { if (live.delete(id)) timers.clear(id); };
		Object.defineProperty(g, "__zincTimerFire", {
			value: (id, kind) => {
				const t = live.get(id);
				if (!t) return false;
				if (kind !== "interval") live.delete(id);
				try { t.fn(...t.args); } catch (e) { g.console.error("timer callback threw:", e); }
				return true;
			},
		});
	}

	// ---- TextEncoder / TextDecoder (UTF-8 only) ----
	if (typeof g.TextEncoder === "undefined") {
		g.TextEncoder = class TextEncoder {
			get encoding() { return "utf-8"; }
			encode(s = "") {
				s = String(s);
				const b = [];
				for (let i = 0; i < s.length; i++) {
					let c = s.charCodeAt(i);
					if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
					else if (c >= 0xd800 && c < 0xe000) c = 0xfffd; // lone surrogate
					if (c < 0x80) b.push(c);
					else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
					else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
					else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
				}
				return Uint8Array.from(b);
			}
			encodeInto(s, dest) {
				const b = this.encode(s);
				const n = Math.min(b.length, dest.length);
				let k = n;
				while (k > 0 && k < b.length && (b[k] & 0xc0) === 0x80) k--; // do not cut a character
				dest.set(b.subarray(0, k));
				return { read: new TextDecoder().decode(b.subarray(0, k)).length, written: k };
			}
		};
	}
	if (typeof g.TextDecoder === "undefined") {
		g.TextDecoder = class TextDecoder {
			constructor(label = "utf-8", opts = {}) {
				const l = String(label).toLowerCase();
				if (l !== "utf-8" && l !== "utf8") throw new RangeError(`TextDecoder: only utf-8 is supported, not ${label}`);
				this.fatal = !!opts.fatal;
				this.ignoreBOM = !!opts.ignoreBOM;
			}
			get encoding() { return "utf-8"; }
			decode(input) {
				if (input === undefined) return "";
				const u = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
				let i = 0, out = "";
				if (!this.ignoreBOM && u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) i = 3;
				const bad = () => { if (this.fatal) throw new TypeError("The encoded data was not valid utf-8"); out += "�"; };
				while (i < u.length) {
					const c = u[i];
					const n = c < 0x80 ? 0 : c >= 0xc2 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : -1;
					if (n < 0) { bad(); i++; continue; }
					let cp = n === 0 ? c : c & (0x3f >> n), j = 1;
					for (; j <= n; j++) {
						const d = u[i + j];
						// the second byte of E0, ED, F0, F4 has a narrower range (no overlongs, surrogates or > U+10FFFF)
						const lo = j === 1 ? (c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80) : 0x80;
						const hi = j === 1 ? (c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf) : 0xbf;
						if (d === undefined || d < lo || d > hi) break;
						cp = (cp << 6) | (d & 63);
					}
					if (j <= n) { bad(); i += j; continue; } // one U+FFFD for the maximal invalid prefix
					out += String.fromCodePoint(cp);
					i += n + 1;
				}
				return out;
			}
		};
	}
}
