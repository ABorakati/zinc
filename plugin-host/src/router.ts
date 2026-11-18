// Runs one import call against a HandlerTable and turns the outcome into a WireResult. Shared by the host process (where: "host")
// and the supervisor (where: "zinc") so both behave the same.
import { WitError, type HandlerContext, type HandlerTable } from "./imports/registry";
import { PluginError, type WireResult } from "./protocol";

export async function runHandler(
	table: HandlerTable,
	ctx: HandlerContext,
	iface: string,
	fn: string,
	args: unknown[],
	onBug: (message: string) => void,
): Promise<WireResult> {
	try {
		return { ok: true, value: await table.call(ctx, iface, fn, args) };
	} catch (e) {
		if (e instanceof WitError) return { ok: false, error: { kind: "wit", payload: e.payload } };
		if (e instanceof PluginError) return { ok: false, error: e.error };
		onBug(`handler ${iface}#${fn} threw: ${(e as Error)?.stack ?? e}`);
		return { ok: false, error: { kind: "wit", payload: { tag: "internal", val: String((e as Error)?.message ?? e) } } };
	}
}
