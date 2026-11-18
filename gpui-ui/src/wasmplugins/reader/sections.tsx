// Plugin item pane sections in reader tabs (decision of 2026-11-18). The extend area registers sections (`extend.register-section`,
// wasmplugins/extend/registry.ts) and draws them as a column of frames with `PluginSectionsList`; this file puts that column in a
// sidebar tab of the reader ("Plugins") for the document's parent item, with the reader tab as the section context
// (`view-context.params.tabType` = "reader"). The tab exists only while some plugin registered a section. The extend module imports the
// app store, so it is loaded on first use.
import { createResource, Show, type JSX } from "solid-js";
import { registerReaderPlugin, unregisterReaderPlugin, type ReaderContext, type ReaderPlugin } from "../../reader/plugins";
import { createEffect, createRoot, onCleanup } from "solid-js";
import { registries } from "../extend/registry";

export const SECTIONS_PLUGIN_ID = "wasm:sections";

function SectionsPanel(p: { ctx: ReaderContext }): JSX.Element {
	const [mod] = createResource(() => import("../extend/Sections"));
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "scroll" }}>
			<Show when={mod()}>
				{(m) => {
					const List = m().PluginSectionsList;
					return <List tab={{ id: p.ctx.attachmentKey, kind: "reader", subtype: "pdf" } as never} itemKey={p.ctx.itemKey || undefined} />;
				}}
			</Show>
		</div>
	);
}

export const sectionsPlugin: ReaderPlugin = {
	id: SECTIONS_PLUGIN_ID,
	sidePanel: { id: "plugin-sections", label: "Plugins", icon: "puzzle", render: (ctx) => <SectionsPanel ctx={ctx} /> },
};

let stop: (() => void) | undefined;
/** Show the "Plugins" sidebar tab while any section is registered. Idempotent; returns the stop function. */
export function startSectionsTab(): () => void {
	if (stop) return stop;
	stop = createRoot((dispose) => {
		let on = false;
		createEffect(() => {
			const want = registries.sections.list().length > 0;
			if (want && !on) registerReaderPlugin(sectionsPlugin);
			else if (!want && on) unregisterReaderPlugin(SECTIONS_PLUGIN_ID);
			on = want;
		});
		onCleanup(() => {
			if (on) unregisterReaderPlugin(SECTIONS_PLUGIN_ID);
		});
		return () => {
			dispose();
			stop = undefined;
		};
	});
	return stop;
}
