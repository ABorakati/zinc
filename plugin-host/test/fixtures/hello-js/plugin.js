// QuickJS test plugin for plugin-host (componentize-qjs). Same world as hello-rust: lifecycle + events, imports prefs, log, timers.
import prefs from "zinc:plugin/prefs@0.1.0";
import log from "zinc:plugin/log@0.1.0";
import timers from "zinc:plugin/timers@0.1.0";
import net from "zinc:plugin/net@0.1.0";
import attachments from "zinc:plugin/attachments@0.1.0";

const info = (message) => log.write("info", message);

export const lifecycle = {
	install() {},
	startup(data, why) {
		info(`hello-js startup ${data.id} ${data.version} why=${why}`);
		const g = prefs.get("greeting");
		info(`pref greeting=${g ? g.val : "missing"}`);
		try {
			const id = timers.setTimeout(10);
			info(`timer=ok(${id})`);
		} catch (e) {
			info(`timer=err(${e.payload ? e.payload.tag : e})`);
		}
	},
	shutdown() {
		info("hello-js shutdown");
	},
	uninstall() {},
	mainWindowLoad() {},
	mainWindowUnload() {},
};

export const events = {
	onPrefChanged() {},
	onTimer(timer, kind) {
		info(`js timer ${timer} ${kind} fired`);
		// WIT resources. 100: a resource the guest constructs (attachments.file-writer). 101: one the host makes (net.body-reader).
		if (timer === 100) {
			const w = new attachments.FileWriter({ filename: "a.txt", collections: [], data: new Uint8Array() });
			w.append(new Uint8Array([1, 2, 3]));
			w.append(new Uint8Array([4, 5]));
			info(`writer key=${w.finish()}`);
		}
		if (timer === 101) {
			const res = net.sendStreamed({ method: "GET", url: "https://example.test/", headers: [], redirect: "follow", cookies: { tag: "none" }, bypassCache: false });
			info(`streamed status=${res.status}`);
			for (let chunk = res.body.read(4); chunk; chunk = res.body.read(4)) info(`chunk ${chunk.length}`);
			res.body.close();
			info("body closed");
		}
		if (timer === 102) {
			// a constructor that fails on the host side shows at the first method call
			const w = new attachments.FileWriter({ filename: "", collections: [], data: new Uint8Array() });
			try {
				w.append(new Uint8Array([1]));
			} catch (e) {
				info(`writer error=${e.payload ? e.payload.tag : e}`);
			}
		}
	},
	onPluginEvent() {},
	onLocaleChanged() {},
	onPermissionChanged() {},
};
