// Template of the entry of a plugin's AOT executable. aot.ts fills in the three marked lines (absolute paths) and writes the result to a
// scratch folder. Everything here is compiled ahead of time: the jco glue (static import), and every core .wasm (a plain import, which
// makes the build compile the module to machine code; the runtime then finds the compiled copy by content when the glue builds it from
// the bytes). The same shape as gpui-ui/scripts/build.ts does for fulltext.wasm.
// @ts-nocheck
import { startRuntime } from "__RUNTIME__";
import { instantiate } from "__GLUE__";
//__WASM_IMPORTS__
const cores = {
//__WASM_TABLE__
};

const send = (m) => process.send(m);
const handle = startRuntime(send, (_spec, imports) =>
	instantiate(async (p) => {
		const f = cores[p];
		if (!f) throw new Error(`core module ${p} was not compiled in`);
		return WebAssembly.compile(await Bun.file(f).arrayBuffer());
	}, imports),
);
process.on("message", handle);

// Lifetime: the host holds our stdin. When it closes (plugin unloaded, host killed) we exit; so do we if the host process is gone.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
const parent = Number(process.env.ZN_PARENT_PID);
if (parent)
	setInterval(() => {
		try {
			process.kill(parent, 0);
		} catch {
			process.exit(0);
		}
	}, 1000).unref();
