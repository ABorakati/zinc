// Probe: where does memory go when pages are pushed into <img> elements? (temporary investigation script)
//   bun scripts/reader-probe.tsx <mode> [rounds]
//   mode = same     : one <img>, setImagePixels with a new 593x790 bitmap each round
//          remount  : a <img> is mounted, filled, then unmounted, a new one mounted, each round
//          nosetimg : <img> mounted/unmounted without pixels
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createSignal, For, Show } from "solid-js";
import { render } from "@gpuix/solid";
import { createTestRoot } from "@gpuix/solid/testing";

const k32 = dlopen("kernel32.dll", {
	GetCurrentProcess: { args: [], returns: FFIType.ptr },
	K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
});
const pmc = new Uint8Array(80),
	dv = new DataView(pmc.buffer);
const mem = () => {
	dv.setUint32(0, 80, true);
	k32.symbols.K32GetProcessMemoryInfo(k32.symbols.GetCurrentProcess(), ptr(pmc), 80);
	return `priv ${Math.round(Number(dv.getBigUint64(72, true)) / 1048576)} ws ${Math.round(Number(dv.getBigUint64(16, true)) / 1048576)}`;
};

const mode = process.argv[2] ?? "same";
const rounds = Number(process.argv[3] ?? 40);
const W = 593,
	H = 790;
const real = process.argv.includes("--window");
const t = real ? null : createTestRoot({ width: 800, height: 880 });
const [gen, setGen] = createSignal(0);
let el: any;
const tree = () => (
	<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
		<Show
			when={mode === "same"}
			fallback={
				<For each={[gen()]}>
					{() => (
						<img
							ref={(e) => {
								el = e;
							}}
							objectFit="fill"
							style={{ width: W, height: H }}
						/>
					)}
				</For>
			}
		>
			<img
				ref={(e) => {
					el = e;
				}}
				objectFit="fill"
				style={{ width: W, height: H }}
			/>
		</Show>
	</div>
);
if (real) render(tree, { title: "probe", width: 800, height: 880 });
else t!.render(tree);
const flush = async (n = 3) => {
	for (let i = 0; i < n; i++) {
		t?.renderer.flush();
		await Bun.sleep(real ? 30 : 10);
	}
};
await flush(10);
console.log("start", mem());
const buf = Buffer.alloc(W * H * 4, 200);
const ft: number[] = [];
for (let i = 0; i < rounds; i++) {
	if (mode !== "same") {
		setGen(i + 1);
		await flush(2);
	}
	buf[0] = i; // keep distinct
	if (mode !== "nosetimg") el.setImagePixels(W, H, buf, { format: "bgra" });
	const t0 = performance.now();
	await flush(2);
	ft.push(performance.now() - t0);
	if ([0, 4, 9, 19, 39].includes(i)) {
		Bun.gc(true);
		console.log("round", i + 1, mem());
	}
}
console.log("flush ms (2 flushes) median", ft.sort((a, b) => a - b)[ft.length >> 1]!.toFixed(1));
Bun.gc(true);
await Bun.sleep(300);
await flush(5);
console.log("end", mem());
process.exit(0);
