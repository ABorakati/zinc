// One memory-profile stage in a fresh process (driven by scripts/profile-mem.ts, or run by hand):
//
//   bun scripts/profile-stage.tsx <stage> [--window] [--wait 6] [--marks 1,3,10,30] [--gc] [--vm] [--w 1400 --h 900]
//
// stages (the library window is drawn with the real components; probes draw synthetic nodes):
//   bare       nothing (Bun itself)                      import   + import @gpuix/solid (loads the .node addon)
//   empty      + an empty window / test root, no fonts   fonts    + the UI fonts registered (src/fonts.ts)
//   hello      + src/hello.tsx                           topbar | sidebar | toolbar | sortbar | cards   one piece of the UI each
//   appimport  App's modules imported, nothing mounted   app      the whole <App/> with data from ZN_URL
//   n-div | n-text | n-svg | n-svg-uniq   NN (env, default 300) synthetic nodes of one kind: native cost per node
//
// Default is the headless test renderer (createTestRoot); --window opens a real GPUI window (visible; never click or type in it).
// Prints "SAMPLE {json}" lines: private bytes / working set / peak WS (Win32 K32GetProcessMemoryInfo via bun:ffi, the same
// numbers Get-Process reports) plus Bun heap numbers. --vm adds a VirtualQuery walk (image vs mapped vs private, region sizes).
//
// Run as source, Babel is loaded by bunfig's preload and inflates everything by ~70-150 MB private. To see the shipped shape,
// compile it:  bun scripts/build.ts --entry scripts/profile-stage.tsx --out out-prof --variant plain
// then:        bun scripts/profile-mem.ts --exe out-prof/zotero-next-gpui-plain.exe --window ...
import { dlopen, FFIType, ptr } from "bun:ffi";
import { heapStats } from "bun:jsc";

const stage = process.argv[2] ?? "bare";
const flag = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const windowed = flag("window");
const waitS = Number(opt("wait", "6"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const k32 = dlopen("kernel32.dll", {
	GetCurrentProcess: { args: [], returns: FFIType.ptr },
	K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	VirtualQuery: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
	K32EnumProcessModules: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	K32GetModuleFileNameExW: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
});
const MB = 1048576;

function winMem() {
	const buf = new BigUint64Array(10); // PROCESS_MEMORY_COUNTERS_EX = 80 bytes
	new DataView(buf.buffer).setUint32(0, 80, true);
	k32.symbols.K32GetProcessMemoryInfo(k32.symbols.GetCurrentProcess(), ptr(buf), 80);
	const mb = (v: bigint) => +(Number(v) / MB).toFixed(1);
	return { privateMB: mb(buf[9]!), wsMB: mb(buf[2]!), peakWsMB: mb(buf[1]!) };
}

/** --vm: walk this process's address space and classify committed memory (image = DLL/exe mappings, private = heaps/GPU driver). */
function vmReport() {
	const mbi = new BigUint64Array(6);
	const dv = new DataView(mbi.buffer);
	let addr = 0n;
	const tot = { image: 0n, mapped: 0n, private: 0n };
	const imageBy = new Map<bigint, bigint>();
	const buckets: Record<string, { n: number; mb: number }> = {};
	for (let guard = 0; guard < 400000; guard++) {
		if (k32.symbols.VirtualQuery(addr, ptr(mbi), 48n) === 0n) break;
		const base = mbi[0]!, allocBase = mbi[1]!, size = mbi[3]!;
		const state = dv.getUint32(32, true), type = dv.getUint32(40, true);
		if (state === 0x1000) {
			if (type === 0x1000000) { tot.image += size; imageBy.set(allocBase, (imageBy.get(allocBase) ?? 0n) + size); }
			else if (type === 0x40000) tot.mapped += size;
			else if (type === 0x20000) {
				tot.private += size;
				const k = size >= 64n * 1048576n ? ">=64MB" : size >= 16n * 1048576n ? "16-64MB" : size >= 4n * 1048576n ? "4-16MB" : size >= 1048576n ? "1-4MB" : "<1MB";
				const b = (buckets[k] ??= { n: 0, mb: 0 });
				b.n++; b.mb += Number(size) / MB;
			}
		}
		addr = base + size;
		if (size === 0n) break;
	}
	const me = k32.symbols.GetCurrentProcess();
	const hm = new BigUint64Array(2048), need = new Uint32Array(1);
	k32.symbols.K32EnumProcessModules(me, ptr(hm), 2048 * 8, ptr(need));
	const names = new Uint16Array(1024);
	const mods: { name: string; mb: number }[] = [];
	for (let i = 0; i < Math.min(2048, Number(need[0]) / 8); i++) {
		const len = k32.symbols.K32GetModuleFileNameExW(me, hm[i]!, ptr(names), 1024);
		mods.push({ name: String.fromCharCode(...names.subarray(0, len)).split("\\").pop()!, mb: +(Number(imageBy.get(hm[i]!) ?? 0n) / MB).toFixed(1) });
	}
	mods.sort((a, b) => b.mb - a.mb);
	for (const b of Object.values(buckets)) b.mb = +b.mb.toFixed(1);
	return { imageMB: +(Number(tot.image) / MB).toFixed(1), mappedMB: +(Number(tot.mapped) / MB).toFixed(1), privateCommittedMB: +(Number(tot.private) / MB).toFixed(1), topModules: mods.slice(0, 12), privateRegionBuckets: buckets };
}

function sample(label: string) {
	if (flag("gc")) Bun.gc(true);
	const m = process.memoryUsage();
	const h = heapStats();
	return {
		stage: label,
		mode: windowed ? "window" : "test",
		...winMem(),
		jsHeapMB: +(h.heapSize / MB).toFixed(1),
		jsExtraMB: +(h.extraMemorySize / MB).toFixed(1),
		objects: h.objectCount,
		rssMB: +(m.rss / MB).toFixed(1),
		externalMB: +(m.external / MB).toFixed(1),
	};
}
const out = (label: string) => console.log("SAMPLE " + JSON.stringify(sample(label)));

if (stage === "bare") {
	await sleep(500);
	out(stage);
	process.exit(0);
}

const solid = await import("@gpuix/solid");
if (stage === "import") {
	await sleep(500);
	out(stage);
	process.exit(0);
}

type Comp = () => unknown;
const NN = Number(process.env.NN ?? 300);
const wrap = { width: "100%", height: "100%", flexDirection: "row", flexWrap: "wrap" } as const;
let comp: Comp = () => <div style={{ width: "100%", height: "100%" }} />;

if (stage === "hello") comp = (await import("../src/hello")).Hello as Comp;
if (stage === "topbar") comp = (await import("../src/TopBar")).TopBar as Comp;
if (stage === "sidebar") comp = (await import("../src/Sidebar")).Sidebar as Comp;
if (stage === "toolbar" || stage === "sortbar") {
	const m = await import("../src/Toolbar");
	const toolbar = stage === "toolbar";
	comp = () => <div style={{ width: "100%" }}>{toolbar ? <m.Toolbar /> : <m.SortBar />}</div>;
}
if (stage === "cards") comp = (await import("../src/cards/CardList")).CardList as Comp;
if (stage === "appimport") await import("../src/App"); // JS-module cost only, nothing mounted
if (stage === "app") comp = (await import("../src/App")).App as Comp;
if (stage === "n-div") comp = () => <div style={wrap}>{Array.from({ length: NN }, () => <div style={{ width: 20, height: 10, backgroundColor: "#333", borderRadius: 3 }} />)}</div>;
if (stage === "n-text") comp = () => <div style={wrap}>{Array.from({ length: NN }, (_, i) => <text style={{ color: "#888", fontSize: 13, fontFamily: "Inter", lineHeight: 18 }}>{"w" + i}</text>)}</div>;
if (stage === "n-svg" || stage === "n-svg-uniq") {
	const { iconSvg } = await import("../src/icons");
	const src = (i: number) => stage === "n-svg" ? iconSvg("star") : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2"><circle cx="12" cy="12" r="' + (3 + (i % 8)) + '"/></svg>';
	comp = () => <div style={wrap}>{Array.from({ length: NN }, (_, i) => <svg source={src(i)} style={{ width: 16, height: 16, color: "#888" }} />)}</div>;
}

const withFonts = stage !== "empty";
const { registerFonts } = await import("../src/fonts");
if (windowed) {
	if (withFonts) registerFonts();
	solid.render(comp as never, { title: "zn-profile", width: Number(opt("w", "1400")), height: Number(opt("h", "900")) });
} else {
	const { createTestRoot } = await import("@gpuix/solid/testing");
	const t = createTestRoot({ width: Number(opt("w", "1400")), height: Number(opt("h", "900")) });
	if (withFonts) registerFonts(t.renderer);
	t.render(comp as never);
	(globalThis as Record<string, unknown>).__t = t;
}

if (stage === "app") {
	const { store } = await import("../src/store");
	for (let i = 0; i < 100 && store.total() === 0; i++) await sleep(100);
	console.log("store.total", store.total(), "error", store.error());
}
const t0 = performance.now();
const marks = opt("marks", "") ? opt("marks", "").split(",").map(Number) : [1, 3, waitS];
for (const s of marks) {
	await sleep(Math.max(0, s * 1000 - (performance.now() - t0)));
	if (!windowed) (globalThis as { __t?: { renderer: { flush(): void } } }).__t?.renderer.flush();
	out(`${stage}@${s}s`);
}
if (windowed) {
	const r = (globalThis as Record<symbol, { renderer?: { getWindowSize?(): unknown; getAutomationTree?(): string } }>)[Symbol.for("@gpuix/solid/render-host")]?.renderer;
	const tree = String(r?.getAutomationTree?.() ?? "");
	console.log("windowSize", JSON.stringify(r?.getWindowSize?.()), "host nodes ~", (tree.match(/"id":/g) ?? []).length);
}
if (flag("vm")) console.log("VM " + JSON.stringify(vmReport(), null, 1));
process.exit(0);
