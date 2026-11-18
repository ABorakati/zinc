#!/usr/bin/env bun
// Scaffold a new Zinc WASM plugin (JS/QuickJS or Rust) with the parts you pick. No network, no dependencies.
//
//   bun <skill>/scripts/scaffold.ts <dir> --id my-plugin@example.com --name "My Plugin" --lang js|rust
//        [--with menu,column,section,prefs,dialog,notifier,library,reader,net,toast] [--no-l10n] [--zinc <zinc root>] [--force]
//
// Parts:  menu      Tools-menu command                      column   item list column
//         section   item pane section with a button         prefs    a boolean pref + settings pane + pref observer
//         dialog    non-blocking dialog (adds a menu entry) notifier library change subscription
//         library   read-only library query (menu entry)    reader   reader toolbar button
//         net       one HTTP GET (menu entry)               toast    only toasts (a ui import, no views)
// The script picks the smallest world and the fewest permissions the parts need and prints what it chose.
// After scaffolding:  bun <zinc>/plugin-api/sdk/js/scripts/build.ts <dir>        (JS)
//                     bun <zinc>/plugin-host/scripts/build-plugin.ts <dir>       (Rust)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---- args ------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n: string) => {
	const i = argv.indexOf(n);
	if (i < 0) return false;
	argv.splice(i, 1);
	return true;
};
const opt = (n: string) => {
	const i = argv.indexOf(n);
	if (i < 0) return undefined;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const id = opt("--id");
const displayName = opt("--name");
const lang = opt("--lang") ?? "js";
const withArg = opt("--with") ?? "menu";
const zincArg = opt("--zinc");
const noL10n = flag("--no-l10n");
const force = flag("--force");
const dirArg = argv[0];
const die = (m: string): never => {
	console.error("scaffold: " + m);
	process.exit(2);
};
if (!dirArg || !id || !displayName) die('usage: scaffold.ts <dir> --id name@domain --name "Display Name" --lang js|rust [--with menu,column,...]');
if (lang !== "js" && lang !== "rust") die("--lang must be js or rust");
if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(id!)) die(`id "${id}" must look like name@domain (letters, digits . _ + - ; a domain after @)`);

const PARTS = ["menu", "column", "section", "prefs", "dialog", "notifier", "library", "reader", "net", "toast"] as const;
type Part = (typeof PARTS)[number];
const parts = new Set<Part>();
for (const p of withArg.split(",").map((s) => s.trim()).filter(Boolean)) {
	if (!(PARTS as readonly string[]).includes(p)) die(`unknown part "${p}" (have: ${PARTS.join(", ")})`);
	parts.add(p as Part);
}
// parts that need a menu entry to be reachable
if (parts.has("dialog") || parts.has("library") || parts.has("net")) parts.add("menu");
const has = (p: Part) => parts.has(p);

// ---- find the Zinc root ----------------------------------------------------------------------------------------------
function findZinc(): string {
	const cands = [zincArg, process.env.ZINC_ROOT, process.cwd(), import.meta.dir].filter(Boolean) as string[];
	for (const c of cands) {
		let d = resolve(c);
		for (let i = 0; i < 10; i++) {
			if (existsSync(join(d, "plugin-api", "wit", "world.wit"))) return d;
			const up = dirname(d);
			if (up === d) break;
			d = up;
		}
	}
	return die("cannot find the Zinc root (the folder with plugin-api/wit). Pass --zinc <path> or set ZINC_ROOT.");
}
const zinc = findZinc().replace(/\\/g, "/");
const dir = resolve(dirArg!);
const fwd = (p: string) => p.replace(/\\/g, "/");
/** A path from `from` to `to` that works in a source file: relative when on the same drive, else absolute. */
function pathTo(from: string, to: string): string {
	const r = relative(from, to);
	return fwd(isAbsolute(r) ? to : r);
}

// ---- what the parts need ---------------------------------------------------------------------------------------------
const needsExtend = has("menu") || has("column") || has("section") || has("prefs") || has("reader");
const needsView = has("section") || has("dialog"); // ui imports AND the ui-events callbacks (dialog close events arrive there)
const needsUiImport = needsView || has("toast");
const worldOf = (): string => {
	if (has("net")) return "plugin";
	if (has("reader") && needsUiImport) return "plugin";
	if (has("reader")) return "plugin-reader";
	if (needsView) return "plugin-ui";
	if (has("toast")) return "plugin-dialogs";
	if (needsExtend) return "plugin-extend";
	if (has("notifier") || has("library")) return "plugin-library";
	return "plugin-core";
};
const world = worldOf();
const rustFeatures: string[] =
	world === "plugin" ? ["full"] : world === "plugin-reader" ? ["reader"] : world === "plugin-ui" ? ["ui"] : world === "plugin-dialogs" ? ["dialogs"] : world === "plugin-extend" ? ["extend"] : world === "plugin-library" ? ["library"] : [];

const caps = new Set<string>();
const reasons: Record<string, string> = {};
const need = (c: string, why: string) => {
	caps.add(c);
	reasons[c] = why;
};
if (has("library") || has("notifier")) need("library.read", "Read item counts and see which items change.");
if (has("reader")) need("reader.ui", "Add a button to the reader toolbar.");
const netHosts = has("net") ? ["example.com"] : [];
if (has("net")) reasons["net.hosts"] = "Fetch a sample page from example.com.";

const slug = id!.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plugin";
const Q = (s: string) => JSON.stringify(s);

// ---- manifest, locale ------------------------------------------------------------------------------------------------
const manifest: Record<string, unknown> = {
	manifest_version: 1,
	id,
	name: displayName,
	version: "0.1.0",
	...(noL10n ? { description: `${displayName}: a Zinc plugin.` } : { description_l10n: "plugin-description" }),
	author: "",
	license: "MIT",
	zinc: { api_version: "0.1" },
	main: { wasm: "plugin.wasm", world, language: lang },
	activation_events: ["onStartup"],
	permissions: { capabilities: [...caps], ...(netHosts.length ? { net: { hosts: netHosts } } : {}) },
	permission_reasons: reasons,
	...(has("prefs") ? { default_prefs: { enabled: true } } : {}),
	...(noL10n ? {} : { locales: { default: "en-US" } }),
};
if (!manifest.author) delete manifest.author;
if (!Object.keys(reasons).length) delete manifest.permission_reasons;

const ftl = `# Fluent strings of ${displayName}. Message ids are kebab-case; reference them with a localized text (see references/recipes-*.md).
plugin-description = ${displayName}: a Zinc plugin.
hello-label = Say hello
`;

// ---- JS --------------------------------------------------------------------------------------------------------------
/** Add `n` tabs to every non-empty line. Fragments below are written at indent 0. */
const tabs = (s: string, n: number) => s.split("\n").map((l) => (l ? "\t".repeat(n) + l : l)).join("\n");

function genJs(): string {
	const sdk = pathTo(join(dir, "src"), join(zinc, "plugin-api/sdk/js/src/index.ts"));
	const imp: string[] = [];
	const top: string[] = [];
	const startup: string[] = [];
	const shutdown: string[] = [];
	const menuEntries: string[] = [];
	const menuCmd: string[] = [];
	const colVals: string[] = [];
	const prefChanged: string[] = [];
	const notifyBody: string[] = [];
	const readerCmd: string[] = [];
	let section = false;

	imp.push(`import log from "zinc:plugin/log@0.1.0";`);
	if (needsExtend) imp.push(`import extend from "zinc:plugin/extend@0.1.0";`);
	if (needsUiImport) imp.push(`import zui from "zinc:plugin/ui@0.1.0";`);
	if (has("prefs")) imp.push(`import prefs from "zinc:plugin/prefs@0.1.0";`);
	if (has("library")) imp.push(`import library from "zinc:plugin/library@0.1.0";`);
	if (has("notifier")) imp.push(`import notifier from "zinc:plugin/notifier@0.1.0";`);
	if (has("reader")) imp.push(`import reader from "zinc:plugin/reader@0.1.0";`);
	if (has("net")) imp.push(`import net from "zinc:plugin/net@0.1.0";`);

	if (has("menu")) {
		top.push(`const MENU = ${Q(slug + "-menu")};`);
		menuEntries.push(noL10n ? `ext.entry(${Q(slug + ".hello")}, "Say hello")` : `ext.entry(${Q(slug + ".hello")}, ext.localized("hello-label", undefined, "Say hello"))`);
		menuCmd.push(
			`if (entryId === ${Q(slug + ".hello")}) {\n\tlog.write("info", \`hello from the menu (\${ctx.itemCount} item(s) selected)\`);` +
				(needsUiImport ? `\n\tzui.showToast(ui.toastSpec(${Q(displayName!)}, "Hello!", "success"));` : "") +
				`\n\treturn;\n}`,
		);
	}
	if (has("column")) {
		top.push(`const COLUMN = ${Q(slug + "-col")};`);
		startup.push(`extend.registerColumn(ext.column(COLUMN, ${Q(displayName!)}));`);
		colVals.push(
			`if (dataKey !== COLUMN) fail("invalid-argument", \`unknown column \${dataKey}\`);\n// One cell per key, in order. Do the real work in ONE batched import call for all keys, not one call per key.\nreturn keys.map((key) => ({ body: { tag: "text", val: key }, style: "normal", sortKey: { tag: "number", val: key.charCodeAt(0) } }));`,
		);
	}
	if (has("section")) {
		section = true;
		top.push(
			`const SECTION = ${Q(slug + "-section")};\n/** mounted view instance -> state. Instances are bigint. */\nconst mounted = new Map();\n\nfunction sectionView(st) {\n\treturn ui.render(\n\t\tui.column({ style: { gap: 2 } },\n\t\t\tui.text(\`Item \${st.key}: clicked \${st.clicks} time(s)\`, { key: "label" }),\n\t\t\tui.button("Click me", { on: { press: "click" } }),\n\t\t),\n\t);\n}\n\n/** mount and update-context: the host passes the section's item in ctx.params. */\nfunction mountSection(instance, ctx) {\n\tif (ctx.view !== SECTION) return ui.unchanged();\n\tconst key = JSON.parse(ctx.params).itemKey;\n\tif (!key) return ui.render(ui.caption("Select an item"));\n\tconst prev = mounted.get(instance);\n\tconst st = { key, clicks: prev && prev.key === key ? prev.clicks : 0 };\n\tmounted.set(instance, st);\n\treturn sectionView(st);\n}`,
		);
		startup.push(`extend.registerSection(ext.section(SECTION, ${Q(displayName!)}, "info"));`);
	}
	if (has("prefs")) {
		startup.push(
			`extend.registerPrefPane(ext.prefPane(${Q(slug + "-prefs")}, ${Q(displayName!)}, [ext.settingToggle("enabled", "Enabled", "enabled")]));\nprefs.observe("plugin-own", "enabled", false);`,
		);
		top.push(`/** The pref \`enabled\` (default in manifest.json). A pref value is { tag: "flag" | "integer" | "text", val }. */\nfunction isEnabled() {\n\tconst v = prefs.get("enabled");\n\treturn v && v.tag === "flag" ? v.val : true;\n}`);
		prefChanged.push(`log.write("info", \`pref \${name} is now \${JSON.stringify(value)}\`);`);
	}
	if (has("dialog")) {
		top.push(
			`function askName() {\n\tconst content = ui.form({ key: "form" },\n\t\tui.column({ style: { gap: 2 } }, ui.label("Your name"), ui.textInput("", { name: "name", autoFocus: true })),\n\t);\n\tconst spec = ui.dialogSpec(${Q(displayName!)}, content, [\n\t\t{ id: "cancel", label: "Cancel", role: "cancel" },\n\t\t{ id: "ok", label: "OK", role: "accept", isDefault: true },\n\t]);\n\t// open-dialog does not block: the callback runs later, when the dialog's close event arrives\n\tui.dialog(spec, zui).then((out) => {\n\t\tif (out.button !== "ok") return;\n\t\tzui.showToast(ui.toastSpec(${Q(displayName!)}, \`Hello, \${ui.fieldValue(out.values, "name") || "stranger"}!\`, "success"));\n\t});\n}`,
		);
		menuEntries.push(`ext.entry(${Q(slug + ".ask")}, "Ask my name...")`);
		menuCmd.push(`if (entryId === ${Q(slug + ".ask")}) return void askName();`);
	}
	if (has("library")) {
		menuEntries.push(`ext.entry(${Q(slug + ".count")}, "Count items in library")`);
		menuCmd.push(
			`if (entryId === ${Q(slug + ".count")}) {\n\t// fill() sets the required record fields you leave out (a missing one traps the guest)\n\tconst total = library.countItems(fill("library/ItemQuery", { scope: { tag: "all" } }));\n\tlog.write("info", \`\${total} top-level items\`);\n\treturn;\n}`,
		);
	}
	if (has("net")) {
		top.push(
			`/** Bytes -> string. QuickJS has no TextDecoder, so decode by hand. */\nfunction utf8(bytes) {\n\tlet s = "";\n\tfor (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);\n\ttry { return decodeURIComponent(escape(s)); } catch { return s; }\n}`,
		);
		menuEntries.push(`ext.entry(${Q(slug + ".fetch")}, "Fetch example.com")`);
		menuCmd.push(
			`if (entryId === ${Q(slug + ".fetch")}) {\n\ttry {\n\t\tconst res = net.send(fill("net/HttpRequest", { method: "GET", url: "https://example.com/", headers: [], redirect: "follow", cookies: { tag: "none" }, bypassCache: false }));\n\t\tlog.write("info", \`HTTP \${res.status}, \${utf8(res.body).length} chars\`);\n\t} catch (e) {\n\t\tlog.write("warn", \`fetch failed: \${JSON.stringify(e.payload ?? String(e))}\`); // e.payload is the net-error variant\n\t}\n\treturn;\n}`,
		);
	}
	if (has("notifier")) {
		startup.push(`notifier.subscribe({ types: ["item"], kinds: ["add", "modify", "trash"], priority: 0, skipOwn: true, maxDelayMs: 250, label: ${Q(slug)} });`);
		notifyBody.push(`for (const ev of batch.events) log.write("info", \`\${ev.object} \${ev.kind}: \${ev.ids.join(",")}\`);`);
	}
	if (has("reader")) {
		top.push(`const READER_BTN = ${Q(slug + "-reader")};`);
		startup.push(`reader.registerListener(ext.readerListener(READER_BTN, { tag: "slot", val: "toolbar" }, [ext.entry(${Q(slug + ".reader")}, "Reader action", { icon: "star" })]));`);
		shutdown.push(`reader.unregister(READER_BTN);`);
		readerCmd.push(`if (listenerId === READER_BTN && command === ${Q(slug + ".reader")}) log.write("info", \`reader button on \${context.reader.title}\`);`);
	}
	if (has("menu")) startup.unshift(`extend.registerMenu(ext.menu(MENU, "menubar-tools", [\n${menuEntries.map((e) => "\t" + e + ",").join("\n")}\n]));`);

	const fn = (name: string, args: string, body: string[]) => `${name}(${args}) {\n${tabs(body.join("\n"), 1)}\n},`;
	const group = (name: string, fns: string[]) => `${name}: {\n${tabs(fns.join("\n"), 1)}\n},`;
	const groups: string[] = [];
	groups.push(group("lifecycle", [fn("startup", "", [...startup, `log.write("info", ${Q(slug + " started")});`]), ...(shutdown.length ? [fn("shutdown", "", shutdown)] : [])]));
	if (prefChanged.length) groups.push(group("events", [fn("onPrefChanged", "subscription, scope, name, value", prefChanged)]));
	const eh: string[] = [];
	if (menuCmd.length) eh.push(fn("onMenuCommand", "menuId, entryId, checked, ctx", [`if (menuId !== MENU) return;`, ...menuCmd]));
	if (colVals.length) eh.push(fn("onColumnValues", "dataKey, keys", colVals));
	if (eh.length) groups.push(group("extendHandlers", eh));
	if (section) {
		groups.push(
			group("uiEvents", [
				fn("mount", "instance, ctx", ["return mountSection(instance, ctx);"]),
				fn("updateContext", "instance, ctx", ["return mountSection(instance, ctx);"]),
				fn("onEvent", "instance, event", [`const st = mounted.get(instance);\nif (st && event.handler === "click") {\n\tst.clicks++;\n\treturn sectionView(st); // or ui.push(instance, ui.render(...)) later, from a timer or after a network call\n}\nreturn ui.unchanged();`]),
				fn("unmount", "instance", ["mounted.delete(instance);"]),
			]),
		);
	}
	if (notifyBody.length) groups.push(group("notifierHandler", [fn("onEvents", "subscription, batch", notifyBody)]));
	if (readerCmd.length) groups.push(group("readerEvents", [fn("onMenuCommand", "listenerId, command, context", readerCmd)]));

	const L: string[] = [];
	L.push(`// ${displayName} (${id}). QuickJS guest: the JS is interpreted, so keep it to glue and UI; heavy loops belong in a Rust plugin.`);
	L.push(`// Build: bun ${zinc}/plugin-api/sdk/js/scripts/build.ts .`);
	L.push(`import { definePlugin, fail, fill, ui, ext } from ${Q(sdk)};`);
	L.push(imp.join("\n"));
	L.push("");
	if (top.length) L.push(top.join("\n\n"), "");
	L.push(`const plugin = definePlugin({\n${tabs(groups.join("\n"), 1)}\n});`);
	L.push("");
	L.push(`// The QuickJS guest looks its exports up by these names. Keep the line as it is.`);
	L.push(`export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;`);
	return L.join("\n") + "\n";
}

// ---- Rust ------------------------------------------------------------------------------------------------------------
function genRust(): string {
	const uses: string[] = [];
	const top: string[] = [];
	const startup: string[] = [];
	const shutdown: string[] = [];
	const impl: string[] = [];
	const menuEntries: string[] = [];
	const menuCmd: string[] = [];
	const hostUses: string[] = [];

	if (has("menu")) {
		top.push(`const MENU: &str = ${Q(slug + "-menu")};`);
		menuEntries.push(
			noL10n
				? `MenuEntryBuilder::item(${Q(slug + ".hello")}, "Say hello").build()`
				: `MenuEntryBuilder::item(${Q(slug + ".hello")}, l10n("hello-label").fallback("Say hello")).build()`,
		);
		menuCmd.push(
			`${Q(slug + ".hello")} => {\n                log::info(format!("hello from the menu ({} item(s) selected)", ctx.item_count));` +
				(needsUiImport ? `\n                ui::toast(${Q(displayName!)}, "Hello!", Tone::Success);` : "") +
				`\n            }`,
		);
	}
	if (has("column")) {
		top.push(`const COLUMN: &str = ${Q(slug + "-col")};`);
		startup.push(`reg::register_column(&reg::column(COLUMN, ${Q(displayName!)}))?;`);
		impl.push(
			`    fn on_column_values(data_key: String, keys: Vec<ItemKey>) -> Result<Vec<Cell>, Error> {\n        if data_key != COLUMN {\n            return Err(err::invalid(format!("unknown column {data_key}")));\n        }\n        // One cell per key, in order. Put the real work here: one batched import call for all keys, not one per key.\n        Ok(keys\n            .iter()\n            .map(|key| Cell {\n                body: CellBody::Text(key.clone()),\n                tooltip: None,\n                color: None,\n                style: extend::TextStyle::Normal,\n                sort_key: Some(extend::SortKey::Number(key.bytes().next().unwrap_or(0) as f64)),\n            })\n            .collect())\n    }`,
		);
		hostUses.push("extend", "types::ItemKey");
	}
	if (has("section")) {
		top.push(
			`const SECTION: &str = ${Q(slug + "-section")};\n\nthread_local! {\n    /// mounted view instance -> (item key, clicks). The guest is single threaded, so thread_local is the place for state.\n    static MOUNTED: RefCell<HashMap<InstanceId, (String, u32)>> = RefCell::new(HashMap::new());\n}\n\nfn section_view(key: &str, clicks: u32) -> RenderResult {\n    ui::render(\n        ui::column()\n            .gap(2)\n            .child(ui::text(format!("Item {key}: clicked {clicks} time(s)")).key("label"))\n            .child(ui::button("Click me").on(EventKind::Press, "click")),\n    )\n}`,
		);
		uses.push("use std::cell::RefCell;", "use std::collections::HashMap;");
		startup.push(`reg::register_section(&reg::section(SECTION, ${Q(displayName!)}, "info"))?;`);
		impl.push(
			`    fn mount(instance: InstanceId, ctx: ViewContext) -> RenderResult {\n        Self::update_context(instance, ctx)\n    }\n\n    fn update_context(instance: InstanceId, ctx: ViewContext) -> RenderResult {\n        if ctx.view != SECTION {\n            return ui::unchanged();\n        }\n        match json::string_field(&ctx.params, "itemKey") {\n            Some(key) => {\n                let clicks = MOUNTED.with(|m| match m.borrow().get(&instance) {\n                    Some((k, c)) if *k == key => *c,\n                    _ => 0,\n                });\n                MOUNTED.with(|m| m.borrow_mut().insert(instance, (key.clone(), clicks)));\n                section_view(&key, clicks)\n            }\n            None => ui::render(ui::caption("Select an item")),\n        }\n    }\n\n    fn unmount(instance: InstanceId) {\n        MOUNTED.with(|m| m.borrow_mut().remove(&instance));\n    }\n\n    fn on_ui_event(instance: InstanceId, event: UiEvent) -> RenderResult {\n        if event.handler == "click" {\n            let state = MOUNTED.with(|m| {\n                let mut m = m.borrow_mut();\n                m.get_mut(&instance).map(|(k, c)| {\n                    *c += 1;\n                    (k.clone(), *c)\n                })\n            });\n            if let Some((key, clicks)) = state {\n                return section_view(&key, clicks); // or host::ui::push(instance, &...) later\n            }\n        }\n        ui::unchanged()\n    }`,
		);
		uses.push("use zinc_plugin::json;");
	}
	if (has("prefs")) {
		startup.push(
			`reg::register_pref_pane(&reg::pref_pane(${Q(slug + "-prefs")}, ${Q(displayName!)}, vec![reg::setting_toggle("enabled", "Enabled", "enabled")]))?;\n        prefs::observe(prefs::PrefScope::PluginOwn, "enabled", false)?;`,
		);
		hostUses.push("prefs");
		top.push(`/** The pref \`enabled\` (default in manifest.json). */\n#[allow(dead_code)]\nfn is_enabled() -> bool {\n    !matches!(prefs::get("enabled"), Some(PrefValue::Flag(false)))\n}`);
		impl.push(`    fn on_pref_changed(_subscription: u32, _scope: PrefScope, name: String, _value: Option<PrefValue>) {\n        log::info(format!("pref {name} changed"));\n    }`);
	}
	if (has("dialog")) {
		top.push(
			`fn ask_name() -> Result<(), Error> {\n    let content = ui::form().child(ui::column().gap(2).child(ui::label("Your name")).child(ui::text_input("").name("name").auto_focus()));\n    // open-dialog does not block: the closure runs later, when the dialog's close event arrives\n    ui::ask(${Q(displayName!)}, content, "OK", |values| {\n        if let Some(values) = values {\n            let name = ui::field_text(&values, "name").filter(|n| !n.is_empty()).unwrap_or("stranger");\n            ui::toast(${Q(displayName!)}, format!("Hello, {name}!"), Tone::Success);\n        }\n    })?;\n    Ok(())\n}`,
		);
		menuEntries.push(`MenuEntryBuilder::item(${Q(slug + ".ask")}, "Ask my name...").build()`);
		menuCmd.push(`${Q(slug + ".ask")} => ask_name()?,`);
	}
	if (has("library")) {
		menuEntries.push(`MenuEntryBuilder::item(${Q(slug + ".count")}, "Count items in library").build()`);
		menuCmd.push(
			`${Q(slug + ".count")} => {\n                let query = library::ItemQuery {\n                    library: None,\n                    scope: library::ItemScope::All,\n                    tags: Vec::new(),\n                    text: None,\n                    text_mode: library::TextMode::TitleCreatorYear,\n                    search: None,\n                    fields: Vec::new(),\n                    expand: library::ItemInclude::empty(),\n                    sort: Vec::new(),\n                    limit: 0,\n                    offset: 0,\n                };\n                let total = library::count_items(&query)?;\n                log::info(format!("{total} top-level items"));\n            }`,
		);
		hostUses.push("library");
	}
	if (has("net")) {
		menuEntries.push(`MenuEntryBuilder::item(${Q(slug + ".fetch")}, "Fetch example.com").build()`);
		menuCmd.push(
			`${Q(slug + ".fetch")} => {\n                let req = net::HttpRequest {\n                    method: "GET".into(),\n                    url: "https://example.com/".into(),\n                    headers: Vec::new(),\n                    body: None,\n                    timeout_ms: Some(10_000),\n                    success_codes: None,\n                    redirect: net::RedirectMode::Follow,\n                    credentials: None,\n                    cookies: net::CookieMode::None,\n                    retry: None,\n                    bypass_cache: false,\n                    max_response_bytes: Some(1 << 20),\n                    cancel_key: None,\n                };\n                match net::send(&req) {\n                    Ok(res) => log::info(format!("HTTP {}, {} bytes", res.status, res.body.len())),\n                    Err(e) => log::warn(format!("fetch failed: {e:?}")),\n                }\n            }`,
		);
		hostUses.push("net");
	}
	if (has("notifier")) {
		startup.push(
			`notifier::subscribe(&notifier::Subscription {\n            types: vec![notifier::ObjectType::Item],\n            kinds: vec![notifier::EventKind::Add, notifier::EventKind::Modify, notifier::EventKind::Trash],\n            priority: 0,\n            skip_own: true,\n            max_delay_ms: 250,\n            label: ${Q(slug)}.into(),\n        })?;`,
		);
		impl.push(
			`    fn on_events(_subscription: u32, batch: notifier::EventBatch) {\n        for ev in batch.events {\n            log::info(format!("{:?} {:?}: {}", ev.object, ev.kind, ev.ids.join(",")));\n        }\n    }`,
		);
		hostUses.push("notifier");
	}
	if (has("reader")) {
		top.push(`const READER_BTN: &str = ${Q(slug + "-reader")};`);
		startup.push(
			`let mut toolbar = reg::reader_toolbar(READER_BTN);\n        toolbar.static_menu = vec![MenuEntryBuilder::item(${Q(slug + ".reader")}, "Reader action").icon("star").build()];\n        reg::register_reader_listener(&toolbar)?;`,
		);
		shutdown.push(`reader::unregister(READER_BTN);`);
		hostUses.push("reader");
		impl.push(
			`    fn on_reader_menu_command(listener_id: String, command: String, context: MenuContext) {\n        if listener_id == READER_BTN && command == ${Q(slug + ".reader")} {\n            log::info(format!("reader button on {}", context.reader.title));\n        }\n    }`,
		);
	}
	if (has("menu")) {
		startup.unshift(
			`reg::register_menu(&menu::registration(\n            MENU,\n            MenuTarget::MenubarTools,\n            vec![\n                ${menuEntries.join(",\n                ")},\n            ],\n        ))?;`,
		);
		impl.unshift(
			`    fn on_menu_command(menu_id: String, entry_id: String, _checked: Option<bool>, ctx: Context) -> Result<(), Error> {\n        if menu_id != MENU {\n            return Ok(());\n        }\n        match entry_id.as_str() {\n            ${menuCmd.join("\n            ")}\n            _ => {}\n        }\n        Ok(())\n    }`,
		);
	}

	const hostSet = [...new Set(hostUses)];
	const hostImport = hostSet.length ? `use zinc_plugin::host::{${hostSet.join(", ")}};` : "";
	const L: string[] = [];
	L.push(`//! ${displayName} (${id}). Built against the \`${world}\` world (cargo features: ${rustFeatures.length ? rustFeatures.join(", ") : "none"}).`);
	L.push(`//! Build: bun ${zinc}/plugin-host/scripts/build-plugin.ts .`);
	L.push("");
	L.push([...new Set(uses)].join("\n"));
	if (uses.length) L.push("");
	if (hostImport) L.push(hostImport);
	L.push(`use zinc_plugin::prelude::*;`);
	L.push("");
	if (top.length) L.push(top.join("\n\n"), "");
	L.push(`struct ${pascal(slug)};\n\nimpl Plugin for ${pascal(slug)} {`);
	L.push(`    fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> {\n        ${startup.join("\n        ")}\n        log::info(${Q(slug + " started")});\n        Ok(())\n    }`);
	if (shutdown.length) L.push(`\n    fn shutdown(_data: PluginData, _why: Reason) -> Result<(), Error> {\n        ${shutdown.join("\n        ")}\n        Ok(())\n    }`);
	if (impl.length) L.push("\n" + impl.join("\n\n"));
	L.push(`}\n\nzinc_plugin::export_plugin!(${pascal(slug)});`);
	return L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
function pascal(s: string) {
	const p = s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
	return /^[A-Za-z]/.test(p) ? p : "Plugin" + p;
}

function cargoToml(): string {
	const sdkPath = pathTo(dir, join(zinc, "plugin-api/sdk/rust"));
	const feats = rustFeatures.length ? `, features = [${rustFeatures.map(Q).join(", ")}]` : "";
	return `[package]\nname = ${Q(slug)}\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nzinc-plugin = { path = ${Q(sdkPath)}${feats} }\n\n# Keep this crate out of any parent workspace. Do not set CARGO_TARGET_DIR or profile flags per plugin.\n[workspace]\n`;
}

function tsconfig(): string {
	const types = pathTo(dir, join(zinc, "plugin-api/sdk/js/types/index.d.ts"));
	return (
		JSON.stringify(
			{
				compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, allowJs: true, checkJs: false, types: [] },
				include: ["src", types],
			},
			null,
			"\t",
		) + "\n"
	);
}

// ---- write -----------------------------------------------------------------------------------------------------------
if (existsSync(dir) && readdirSync(dir).length && !force) die(`${dir} is not empty (use --force to write into it)`);
const write = (rel: string, text: string) => {
	const p = join(dir, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, text);
	console.log("  wrote " + rel);
};
console.log(`scaffold: ${id} (${lang}), parts: ${[...parts].join(", ") || "none"}`);
write("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
if (!noL10n) write("locale/en-US/plugin.ftl", ftl);
if (lang === "js") {
	write("src/main.js", genJs());
	write("tsconfig.json", tsconfig());
} else {
	write("Cargo.toml", cargoToml());
	write("src/lib.rs", genRust());
	write(".gitignore", "target/\ndist/\n");
}
console.log(`world: ${world}${lang === "rust" ? `  (cargo features: ${rustFeatures.join(", ") || "none"})` : ""}`);
console.log(`permissions: ${[...caps].join(", ") || "none"}${netHosts.length ? `; net.hosts: ${netHosts.join(", ")}` : ""}`);
console.log(lang === "js" ? `next: bun ${zinc}/plugin-api/sdk/js/scripts/build.ts ${fwd(dir)}` : `next: bun ${zinc}/plugin-host/scripts/build-plugin.ts ${fwd(dir)}`);
