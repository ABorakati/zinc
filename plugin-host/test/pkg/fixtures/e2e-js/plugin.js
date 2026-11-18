// QuickJS test plugin for the package/permissions/imports area. Lifecycle hooks log what they were called with; `events.onTimer` with
// a number of 900 or more runs a probe of one import interface and logs the outcome, so a test can drive it with `supervisor.call`.
import prefs from "zinc:plugin/prefs@0.1.0";
import log from "zinc:plugin/log@0.1.0";
import timers from "zinc:plugin/timers@0.1.0";
import l10n from "zinc:plugin/l10n@0.1.0";
import util from "zinc:plugin/util@0.1.0";
import secrets from "zinc:plugin/secrets@0.1.0";
import app from "zinc:plugin/app@0.1.0";
import permissions from "zinc:plugin/permissions@0.1.0";
import plugins from "zinc:plugin/plugins@0.1.0";

const say = (m) => log.write("info", m);
const err = (e) => (e && e.payload ? e.payload.tag + (e.payload.val !== undefined ? "(" + e.payload.val + ")" : "") : String(e));
const attempt = (label, fn) => {
	try {
		say(label + "=ok:" + JSON.stringify(fn(), (k, v) => (typeof v === "bigint" ? Number(v) : v)));
	} catch (e) {
		say(label + "=err:" + err(e));
	}
};
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const text = (s) => ({ tag: "text", val: s });
const ref = (id, args) => ({ id, args: args || [], fallback: undefined });

export const lifecycle = {
	install(data, why) {
		say("hook install " + why + " v=" + data.version + " prev=" + data.previousVersion);
	},
	startup(data, why) {
		say("hook startup " + why + " v=" + data.version + " prev=" + data.previousVersion);
		const n = prefs.get("starts");
		prefs.set("starts", { tag: "integer", val: (n ? n.val : 0) + 1 });
		say("starts=" + prefs.get("starts").val);
	},
	shutdown(data, why) {
		say("hook shutdown " + why + " v=" + data.version);
	},
	uninstall(data, why) {
		say("hook uninstall " + why + " v=" + data.version);
	},
	mainWindowLoad(data, window) {
		say("hook main-window-load " + window);
	},
	mainWindowUnload(data, window) {
		say("hook main-window-unload " + window);
	},
};

export const events = {
	onPrefChanged(subscription, scope, name, value) {
		say("pref-changed sub=" + subscription + " scope=" + scope + " " + name + "=" + (value ? JSON.stringify(value) : "none"));
	},
	onTimer(timer, kind) {
		if (timer < 900) {
			say("timer " + timer + " " + kind);
			return;
		}
		if (timer === 900) {
			say("probe log");
			log.write("debug", "a debug line");
			say("debug-enabled=" + log.debugEnabled());
			log.writeError("something broke", "at plugin.js:1");
			log.write("info", "x".repeat(9000));
		}
		if (timer === 901) {
			attempt("l10n.hello", () => l10n.format(ref("hello", [{ name: "name", value: text("Ada") }])));
			attempt("l10n.items1", () => l10n.format(ref("items", [{ name: "count", value: { tag: "integer", val: 1n } }])));
			attempt("l10n.items5", () => l10n.format(ref("items", [{ name: "count", value: { tag: "integer", val: 5n } }])));
			attempt("l10n.multi", () => l10n.format(ref("multi")));
			attempt("l10n.term", () => l10n.format(ref("about")));
			attempt("l10n.attr", () => l10n.format(ref("button.tooltip")));
			attempt("l10n.onlyen", () => l10n.format(ref("only-en")));
			attempt("l10n.missing", () => l10n.format(ref("nope")));
			attempt("l10n.fallback", () => l10n.format({ id: "nope", args: [], fallback: "Fallback text" }));
			attempt("l10n.many", () => l10n.formatMany([ref("button"), ref("nope")]));
			attempt("l10n.has", () => [l10n.hasMessage("hello"), l10n.hasMessage("nope"), l10n.hasMessage("button.tooltip")]);
			attempt("l10n.locale", () => l10n.locale());
			attempt("l10n.locales", () => l10n.pluginLocales());
			attempt("l10n.number", () => l10n.formatNumber(1234.5, 2));
			attempt("l10n.date", () => l10n.formatDate(0n, "short", false));
		}
		if (timer === 902) {
			attempt("prefs.get", () => prefs.get("greeting"));
			attempt("prefs.get-none", () => prefs.get("no-such"));
			attempt("prefs.set-type", () => prefs.set("greeting", { tag: "integer", val: 1 }));
			attempt("prefs.set-key", () => prefs.set("bad key!", text("x")));
			attempt("prefs.set", () => prefs.set("greeting", text("hi")));
			attempt("prefs.user", () => [prefs.hasUserValue("greeting"), prefs.hasUserValue("limit")]);
			attempt("prefs.set-many-atomic", () => prefs.setMany([["limit", { tag: "integer", val: 20 }], ["enabled", text("wrong")]]));
			attempt("prefs.limit-after", () => prefs.get("limit"));
			const sub = prefs.observe("plugin-own", "gre", true);
			say("observe=" + JSON.stringify(sub));
			prefs.set("greeting", text("changed"));
			attempt("prefs.getAll", () => prefs.getAll(undefined).map((e) => e.key + ":" + e.userSet));
			prefs.clear("greeting");
			attempt("prefs.after-clear", () => prefs.get("greeting"));
			attempt("prefs.get-app-denied", () => prefs.getApp("ui.locale"));
			attempt("prefs.observe-app-denied", () => prefs.observe("app", "ui.locale", false));
			attempt("prefs.reset", () => prefs.reset(undefined, []));
		}
		if (timer === 903) {
			attempt("secrets.get-none", () => secrets.get("token"));
			attempt("secrets.set", () => secrets.set("token", "s3cret-é"));
			attempt("secrets.get", () => secrets.get("token"));
			attempt("secrets.names", () => secrets.listNames());
			attempt("secrets.big", () => secrets.set("big", "y".repeat(9000)));
			attempt("secrets.badname", () => secrets.set("bad name", "x"));
			attempt("secrets.delete", () => secrets.delete("token"));
			attempt("secrets.after-delete", () => secrets.get("token"));
			secrets.set("keep", "kept");
		}
		if (timer === 904) {
			attempt("perm.library.read", () => permissions.check("library.read"));
			attempt("perm.prefs.app-read", () => permissions.check("prefs.app-read"));
			attempt("perm.library.write", () => permissions.check("library.write"));
			attempt("perm.library.erase", () => permissions.check("library.erase"));
			attempt("perm.list", () => permissions.listPermissions());
			attempt("perm.request-undeclared", () => permissions.request("library.erase", { tag: "plain", val: "please" }));
			attempt("perm.request-denied-required", () => permissions.request("prefs.app-read", { tag: "plain", val: "please" }));
			attempt("perm.request", () => permissions.request("library.write", { tag: "localized", val: ref("button") }));
			attempt("perm.after", () => permissions.check("library.write"));
		}
		if (timer === 905) {
			attempt("util.uuid", () => util.uuidV4().length);
			attempt("util.random", () => util.randomBytes(16).length);
			attempt("util.sha256", () => hex(util.hash("sha256", new Uint8Array([97, 98, 99]))));
			attempt("util.md5", () => hex(util.hash("md5", new Uint8Array([97, 98, 99]))));
			attempt("util.semver", () => [util.semverCompare("1.2.0", "1.10.0"), util.semverCompare("2.0.0", "2.0.0"), util.semverCompare("1.0.0-beta", "1.0.0")]);
			attempt("util.doi", () => util.cleanDoi("see https://doi.org/10.1000/xyz123."));
			attempt("util.isbn", () => util.cleanIsbn("ISBN 0-306-40615-2", true));
			attempt("util.issn", () => util.cleanIssn("ISSN 0378-5955"));
			attempt("util.html", () => util.htmlToText("<p>a &amp; b</p><p>c</p>"));
			attempt("util.title", () => util.capitalizeTitle("the art of war and peace", false));
		}
		if (timer === 906) {
			const a = timers.setTimeout(30);
			const b = timers.setTimeout(30);
			timers.clear(b);
			const c = timers.setInterval(20);
			say("timers=" + a + "," + b + "," + c);
			const t0 = timers.monotonicMs();
			timers.sleep(40);
			say("slept>=35=" + (Number(timers.monotonicMs() - t0) >= 35));
			say("now>2020=" + (Number(timers.now()) > 1577836800000));
		}
		if (timer === 907) {
			attempt("app.info", () => {
				const i = app.getInfo();
				return [i.name, i.version, i.apiVersion, i.platform, i.locale];
			});
			attempt("app.ready", () => app.isUiReady());
			attempt("app.windows", () => app.mainWindows());
			attempt("plugins.self", () => {
				const s = plugins.selfInfo();
				return [s.id, s.name, s.version, s.state, s.granted];
			});
			attempt("plugins.list-denied", () => plugins.listPlugins().map((p) => p.id));
			attempt("plugins.get-other-denied", () => plugins.getInfo("someone@else.test"));
			attempt("plugins.observe-denied", () => plugins.observePlugins());
			attempt("plugins.get-self", () => plugins.getInfo("e2e-js@zinc.test").name);
		}
		if (timer === 908) {
			timers.setTimeout(10);
			timers.setTimeout(10);
			attempt("timers.limit", () => {
				for (let i = 0; i < 70; i++) timers.setInterval(60000);
				return "no limit";
			});
		}
		if (timer === 910) attempt("obs-app", () => prefs.observe("app", "ui.locale", false));
		if (timer === 911) attempt("reset", () => prefs.reset(undefined, []));
		if (timer === 912) attempt("getapp", () => prefs.getApp("ui.locale"));
		if (timer === 909) {
			attempt("plugins.observe", () => plugins.observePlugins());
			attempt("plugins.list", () => plugins.listPlugins().map((p) => p.id + ":" + p.state));
			attempt("plugins.icon", () => {
				const i = plugins.getIcon("e2e-js@zinc.test", 16);
				return i ? i.length : null;
			});
			attempt("plugins.get-other", () => {
				const p = plugins.getInfo("second@zinc.test");
				return p ? p.name : null;
			});
		}
	},
	onPluginEvent(plugin, which, why) {
		say("plugin-event " + plugin + " " + which + " " + why);
	},
	onLocaleChanged(locale) {
		say("locale-changed " + locale);
	},
	onPermissionChanged(permission, granted) {
		say("permission-changed " + permission + " " + granted);
	},
};
