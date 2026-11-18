// QuickJS test plugin for the data area. Timer 1: query the library. Timer 2: write through library.apply. Timer 3: a write
// the plugin has no permission for. Every result goes to the log as one "E2E {json}" line; the test reads those lines.
import log from "zinc:plugin/log@0.1.0";
import library from "zinc:plugin/library@0.1.0";
import notifier from "zinc:plugin/notifier@0.1.0";

const out = (o) => log.write("info", "E2E " + JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));

export const lifecycle = {
	install() {},
	startup() {
		try {
			const id = notifier.subscribe({ types: ["item"], kinds: [], priority: 100, skipOwn: false, maxDelayMs: 20, label: "e2e" });
			out({ subscribed: id });
		} catch (e) {
			out({ subscribeError: e.payload ?? String(e) });
		}
	},
	shutdown() {},
	uninstall() {},
	mainWindowLoad() {},
	mainWindowUnload() {},
};

export const events = {
	onPrefChanged() {},
	onTimer(timer) {
		if (timer === 1) {
			try {
				const page = library.queryItems({
					library: undefined,
					scope: { tag: "all" },
					tags: [],
					text: undefined,
					textMode: "title-creator-year",
					search: undefined,
					fields: ["date"],
					expand: { creators: false, tags: false, collections: false },
					sort: [{ field: "title", ascending: true }],
					limit: 0,
					offset: 0,
				});
				out({ query: { total: page.total, items: page.items.map((i) => ({ key: i.key, title: i.title, fields: i.fields })) } });
			} catch (e) {
				out({ queryError: e.payload ?? String(e) });
			}
		}
		if (timer === 2) {
			try {
				const [key] = library.newKeys(1);
				const res = library.apply(
					[{ tag: "create-item", val: { key, library: undefined, data: JSON.stringify({ itemType: "book", title: "Written by the plugin" }) } }],
					{ skipNotify: false },
				);
				out({ applied: res, key });
			} catch (e) {
				out({ applyError: e.payload ?? String(e) });
			}
		}
		if (timer === 3) {
			try {
				library.apply([{ tag: "trash-items", val: ["AAAAAAA1"] }], { skipNotify: false });
				out({ trashed: true });
			} catch (e) {
				out({ trashError: e.payload ?? String(e) });
			}
		}
	},
	onPluginEvent() {},
	onLocaleChanged() {},
	onPermissionChanged() {},
};

export const notifierHandler = {
	onEvents(sub, batch) {
		out({ batch: { sub, seq: batch.seq, events: batch.events.map((e) => ({ object: e.object, kind: e.kind, ids: e.ids, origin: e.origin })) } });
	},
};
