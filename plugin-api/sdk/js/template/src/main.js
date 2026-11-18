// A Zinc plugin in JavaScript (QuickJS). Build:  bun <zinc>/plugin-api/sdk/js/scripts/build.ts .
// Copy this folder, change the id in manifest.json, and import the SDK from where it lives (the path below assumes the folder
// sits next to plugin-api/samples; adjust it).
import { definePlugin, ext } from "../../../sdk/js/src/index.ts";
import extend from "zinc:plugin/extend@0.1.0";
import log from "zinc:plugin/log@0.1.0";

const plugin = definePlugin({
	lifecycle: {
		startup() {
			extend.registerMenu(ext.menu("hello-menu", "menubar-tools", [ext.entry("hello.say", "Say hello")]));
			log.write("info", "hello started");
		},
	},
	extendHandlers: {
		onMenuCommand(menuId, entryId) {
			if (entryId === "hello.say") log.write("info", "hello!");
		},
	},
});

// The QuickJS guest looks its exports up by these names.
export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
