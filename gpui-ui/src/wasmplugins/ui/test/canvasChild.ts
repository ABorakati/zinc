// Run in a child process by canvasSvg.test.ts: input that used to hang or overflow the stack in `pathBox` / `buildCanvas`.
// The parent kills this process after a time limit, so a regression fails the test and does not freeze the suite.
import fc from "fast-check";
import { buildCanvas, pathBox } from "../canvasSvg";

const mode = process.argv[2];
const done = () => {
	console.log("OK");
	process.exit(0);
};
const within = (label: string, ms: number, fn: () => void) => {
	const t = performance.now();
	fn();
	const took = performance.now() - t;
	if (took > ms) throw new Error(`${label}: ${Math.round(took)} ms (limit ${ms})`);
};
const opts = { mode: "light" as const, txt: () => "", image: () => undefined };
const view = { x: 0, y: 0, width: 100, height: 100 };

if (mode === "cases") {
	// the two loops: a token after `Z` or after a command the parser does not know
	for (const d of ["M 0 0 Z 1", "M 0 0 B 1", "Z 1", "B", "z 1 2 3", "M 0 0 Z 1 Z 1 Z 1", "1 2 Z 3"]) within(d, 1000, () => pathBox(d));
	within("many stray tokens", 3000, () => pathBox("M 0 0 " + "Z 1 ".repeat(200_000)));
	within("many unknown commands", 3000, () => pathBox("M 0 0 " + "B 1 ".repeat(200_000)));
	// the box is still right when the stray tokens are skipped
	const b = pathBox("M 0 0 B 1 L 5 6");
	if (!b || b.x !== 0 || b.y !== 0 || b.w !== 5 || b.h !== 6) throw new Error("box after an unknown command: " + JSON.stringify(b));
	const z = pathBox("M 1 2 L 4 6 Z 9 L 7 8");
	if (!z || z.x !== 1 || z.y !== 2 || z.w !== 6 || z.h !== 6) throw new Error("box after Z and a stray number: " + JSON.stringify(z));
	// long and odd strings
	for (const [label, s] of [
		["digits", "M" + "9".repeat(1_000_000)],
		["minus", "-".repeat(1_000_000)],
		["dots", ".".repeat(1_000_000)],
		["exponent", "1e".repeat(500_000)],
		["minus digits", "-1".repeat(500_000)],
		["dot digits", "1.".repeat(500_000)],
		["spaces", " ".repeat(2_000_000)],
		["letters", "M".repeat(1_000_000)],
		["huge", "M 0 0 " + "L 1 1 ".repeat(1_000_000)],
	] as const)
		within(label, 4000, () => pathBox(s));
	// more points than a spread call can take
	const big = pathBox("M 0 0 " + "L 3 4 ".repeat(300_000));
	if (!big || big.w !== 3 || big.h !== 4) throw new Error("big path box " + JSON.stringify(big));
	// non-finite and overflowing numbers give no box (and no NaN hit)
	for (const d of ["M 1e999 0", "M 0 0 L -1e999 5", "M 1e308 0 L -1e308 0"]) {
		const r = pathBox(d);
		if (r && !Object.values(r).every(Number.isFinite)) throw new Error(`${d}: ${JSON.stringify(r)}`);
	}
	// through buildCanvas, as a hit shape
	within("canvas path hit", 3000, () => {
		const r = buildCanvas({ ops: [{ tag: "path", val: { d: "M 0 0 Z 1", style: { hit: "a" } } }, { tag: "path", val: { d: "M 0 0 B 1", style: { hit: "b" } } }] }, view, opts);
		if (r.hits.length !== 2) throw new Error("hits " + r.hits.length);
	});
	within("canvas polyline hit with 300k points", 3000, () => {
		const points = Array.from({ length: 600_000 }, (_, i) => i % 100);
		const r = buildCanvas({ ops: [{ tag: "polyline", val: { points, closed: false, style: { hit: "p" } } }] }, view, opts);
		const h = r.hits[0]!;
		if (!(h.x === 0 && h.y === 1 && h.w === 98 && h.h === 98)) throw new Error("polyline box " + JSON.stringify([h.x, h.y, h.w, h.h]));
	});
	done();
}

if (mode === "fuzz") {
	const piece = fc.oneof(
		fc.constantFrom("M", "m", "L", "l", "H", "h", "V", "v", "C", "c", "S", "s", "Q", "q", "T", "t", "A", "a", "Z", "z", "B", "e", "E", "x", " ", ",", ".", "-", "+", "1e5", "1e999", "-1e999", "NaN", "\u0000", "é"),
		fc.integer({ min: -50, max: 500 }).map(String),
		fc.double({ noNaN: false }).map(String),
	);
	const path = fc.tuple(fc.array(piece, { maxLength: 80 }), fc.constantFrom(" ", "", ",")).map(([a, sep]) => a.join(sep));
	fc.assert(
		fc.property(path, (d) => {
			const t = performance.now();
			const r = pathBox(d);
			if (performance.now() - t > 500) throw new Error("slow: " + JSON.stringify(d));
			if (r !== undefined) for (const v of [r.x, r.y, r.w, r.h]) if (!Number.isFinite(v)) throw new Error(`non-finite box for ${JSON.stringify(d)}: ${JSON.stringify(r)}`);
		}),
		{ numRuns: 4000 },
	);
	// random draw lists, including ones that are not what the schema allows
	const num = fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double(), fc.constantFrom(undefined, null, "x", {}, [], NaN, Infinity));
	const shape = fc.oneof(fc.constant(undefined), fc.record({ hit: fc.constantFrom("h", undefined), fill: fc.constant(undefined) }));
	const op = fc.oneof(
		fc.record({ tag: fc.constant("rect"), val: fc.record({ x: num, y: num, width: num, height: num, style: shape }) }),
		fc.record({ tag: fc.constant("polyline"), val: fc.record({ points: fc.array(num, { maxLength: 20 }), closed: fc.boolean(), style: shape }) }),
		fc.record({ tag: fc.constant("path"), val: fc.record({ d: path, style: shape }) }),
		fc.record({ tag: fc.constant("push-group"), val: fc.record({ translateX: num, translateY: num, scale: num }) }),
		fc.record({ tag: fc.constant("pop-group") }),
	);
	fc.assert(
		fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
			const r = buildCanvas({ ops }, view, opts);
			if (!r.svg.startsWith("<svg") || !r.svg.endsWith("</svg>")) throw new Error("not an svg document");
		}),
		{ numRuns: 1500 },
	);
	done();
}

throw new Error("unknown mode " + mode);
