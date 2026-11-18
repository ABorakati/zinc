// WASM plugins and the reader: start-up of the bridge. `installReaderBridge()` is called once when plugins start (needs-from-others in
// phase2-reader.md: wasmplugins/index.ts `startWasmPlugins`). It
//   - publishes the service the `reader` / `annotations` / `note-editor` import handlers call,
//   - keeps `readerPlugins()` (src/reader/plugins.ts) in step with what plugins registered (bridge.tsx), plus the "Plugins" sidebar tab
//     for item pane sections (sections.tsx),
//   - delivers `reader-events` (events.ts) and `note-events` (noteevents.ts),
//   - drops a plugin's registrations when the extend area says they must go (stop, disable, failure, host restart).
// Without a supervisor nothing is called: registrations come only from running plugins.
import { onPluginRegistrationsReset } from "../host";
import { startReaderSync, clearOverlayCache } from "./bridge";
import { startReaderEvents } from "./events";
import { clearMenuCache } from "./menus";
import { noteHeadRegistry, stopNoteEvents } from "./noteevents";
import { clearRegistrations } from "./registry";
import { startSectionsTab } from "./sections";
import { createReaderService, setInstalledService } from "./service";

export { bindReaderApp, type ReaderApp } from "./host";
export { setReaderCaller } from "./link";
export { NoteEditorHead } from "./notehead";
export { setPluginViewComponent } from "./view";

let installed: (() => void) | undefined;

/** Install the bridge. Idempotent. Returns the function that removes it (tests, shutdown). */
export function installReaderBridge(): () => void {
	if (installed) return installed;
	setInstalledService(createReaderService());
	const stops = [
		startReaderSync(),
		startSectionsTab(),
		startReaderEvents(),
		onPluginRegistrationsReset((plugin) => {
			clearRegistrations(plugin);
			noteHeadRegistry.clear(plugin);
			clearMenuCache();
			clearOverlayCache();
		}),
	];
	installed = () => {
		for (const s of stops) s();
		stopNoteEvents();
		clearRegistrations();
		setInstalledService(undefined);
		installed = undefined;
	};
	return installed;
}
