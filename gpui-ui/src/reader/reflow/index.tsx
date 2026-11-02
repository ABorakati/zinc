// reflow plugin (reader-next/src/reflow): the reflowed reading view as an alternate full-pane view (the reader core adds the
// labelled "Reading view" toolbar toggle for it). The structure comes from the document worker through the academic session, which
// is shared with the academic plugins, so the document is analysed once.
import { academicFor } from "../academic/session";
import type { ReaderPlugin } from "../plugins";
import { ReflowView, type LoadState } from "./ReflowView";
import { reflowSettings, resetReflowSettings, setReflowSettings } from "./state";

export { reflowSettings, setReflowSettings };

export const reflowPlugin: ReaderPlugin = {
	id: "reflow",
	altView: {
		id: "reflow", label: "Reading view", icon: "book-open",
		render: (ctx) => {
			const s = academicFor(ctx);
			void s.start();
			const state = (): LoadState => {
				const x = s.struct();
				return x.phase === "ready" ? { phase: "ready", doc: x.doc } : x;
			};
			return <ReflowView ctx={ctx} state={state} retry={() => void s.retry()} settings={reflowSettings} setSettings={setReflowSettings} resetSettings={resetReflowSettings} />;
		},
	},
	onOpen(ctx) {
		// open straight into the reading view when the user asked for it
		if (reflowSettings().openByDefault) ctx.setAltView("reflow");
	},
};
