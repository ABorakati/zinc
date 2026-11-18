#!/usr/bin/env bun
// Inventory a Zotero plugin (Zotero 7 to 10; current is 10) (an .xpi, or a repo / unpacked folder) for porting to Zinc.
//
//   bun scan.ts <plugin.xpi | folder> [--json] [--examples N] [--all-files]
//
// What it does (no network, no dependencies beyond Bun and node: built-ins):
//   1. reads manifest.json, bootstrap.js, prefs.js, locale/*.ftl, chrome content, LICENSE / package.json;
//   2. greps every source file for the Zotero / Firefox / DOM APIs in RULES below and maps each one to the Zinc WIT
//      function that replaces it, with the parity-table row and a status (covered, partial, not planned);
//   3. lists the `Zotero.X` / `Services.X` names no rule knows, so you can look them up by hand;
//   4. prints a markdown inventory you paste into the go/no-go report (references/go-no-go.md).
//
// The rules are a first pass over the 580 parity rows (docs/developer-guide/wasm-plugins/*.md), not the rows themselves. When a
// hit matters, open the row (`ref`) and read the exact caveat. Matching is regex over text, so it also works on a bundled,
// even minified, bootstrap (an .xpi built by zotero-plugin-toolkit/esbuild). It sees code that is dead or behind a feature
// flag too: confirm with the user which features they actually care about.
import { inflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

type Status = "covered" | "partial" | "not planned";
interface Rule {
	id: string;
	area: string; // grouping in the report
	re: RegExp; // must have no `g` flag; the scanner adds it
	status: Status;
	zinc: string; // what replaces it
	ref: string; // parity-table rows: "<area> <row numbers>" or "library: <section>"
	note?: string;
}

const R = (area: string, id: string, re: RegExp, status: Status, zinc: string, ref: string, note?: string): Rule => ({ area, id, re, status, zinc, ref, note });

// ---------------------------------------------------------------------------------------------------------------------
// The rule table. Order matters only for readability. Keep `zinc` to the WIT call(s); the long form is references/api-map.md.
// ---------------------------------------------------------------------------------------------------------------------
const RULES: Rule[] = [
	// ---- lifecycle -----------------------------------------------------------------------------------------------
	R("lifecycle", "bootstrap hooks", /\b(?:function\s+)?(install|startup|shutdown|uninstall)\s*\(\s*\{?\s*(?:id|data|version|rootURI)?/, "covered", "lifecycle.install/startup/shutdown/uninstall (exports)", "lifecycle 18-23"),
	R("lifecycle", "onMainWindowLoad/Unload", /\bonMainWindow(?:Load|Unload)\b/, "covered", "lifecycle.main-window-load / -unload (window-id, not a window object)", "lifecycle 23", "Anything done to `window`/`document` in here has no equivalent: see the DOM rules."),
	R("lifecycle", "init promises", /Zotero\.(?:initializationPromise|uiReadyPromise|unlockPromise)/, "covered", "drop: startup runs after init and UI ready", "lifecycle 28"),
	R("lifecycle", "shutdown listener", /Zotero\.addShutdownListener/, "covered", "lifecycle.shutdown (reason app-shutdown)", "lifecycle 29"),
	R("lifecycle", "plugin observer / list", /Zotero\.Plugins\.(?:addObserver|removeObserver|getAllPluginIDs|getName|getIconURI)/, "covered", "plugins.observe-plugins, list-plugins, get-info (needs plugins.read)", "lifecycle 30-31"),
	R("lifecycle", "app info", /Zotero\.(?:version|appName|isMac|isWin|isLinux|locale)\b|Services\.appinfo/, "covered", "app.get-info", "lifecycle 36"),
	R("lifecycle", "main window object", /Zotero\.(?:getMainWindows?|getActiveZoteroPane)\b|\bZoteroPane\b|\bZoteroPane_Local\b/, "partial", "app.main-windows / active-window (ids) + extend.get-context", "lifecycle 35; extend 99", "Live objects (itemsView, collectionsView) are not available: see the Selection rules."),
	R("lifecycle", "plugin singletons / cross-plugin globals", /Zotero\[\s*["'`]?\w*(?:addon|Addon|instance)\w*["'`]?\s*\]|Zotero\.__addonInstance__|Zotero\.[A-Z]\w*Plugin\b/, "not planned", "none: components share no memory. Keep state in module scope.", "lifecycle 37"),
	R("lifecycle", "scope globals & sandbox", /Components\.(?:classes|interfaces|utils)|\bCc\s*\[|\bCi\.|\bCu\.|ChromeUtils\.(?:import|importESModule|defineESModuleGetters)|Cu\.import|Cu\.unload|Cu\.Sandbox|wrappedJSObject/, "not planned", "none", "lifecycle 112"),
	R("lifecycle", "script / chrome registration", /Services\.scriptloader|loadSubScript|aomStartup|registerChrome|chrome\.manifest|amIAddonManagerStartup/, "not planned", "none: the entry is plugin.wasm; files are read through fs root `bundled`", "lifecycle 7, 9"),
	R("lifecycle", "chrome:// / resource:// URLs", /\bchrome:\/\/[\w./-]+|\bresource:\/\/[\w./-]+|rootURI/, "partial", "fs.read with root `bundled`; icons via icon-ref.bundled", "lifecycle 10", "No URL schemes. rootURI is gone."),
	R("lifecycle", "quit / restart / windows", /Services\.(?:startup|appShell|wm|io|console)\b|Zotero\.(?:Utilities\.Internal\.)?(?:quit|restart)\b/, "not planned", "none (a plugin must not close Zinc)", "lifecycle 111"),

	// ---- prefs ---------------------------------------------------------------------------------------------------
	R("prefs", "Zotero.Prefs get/set/clear", /Zotero\.Prefs\.(?:get|set|clear|prefHasUserValue|resetBranch)\b/, "covered", "prefs.get / set / set-many / clear / has-user-value / reset (own branch)", "lifecycle 38-44", "A third argument `true` (global branch) is NOT the own branch: see next rule."),
	R("prefs", "Zotero.Prefs on global / other branches", /Zotero\.Prefs\.(?:get|set)\([^)]*,\s*true\s*\)|Services\.prefs|nsIPrefBranch/, "partial", "prefs.get-app (read only, allowlist, needs prefs.app-read); writes not planned", "lifecycle 39, 41", "With `true` the name is absolute. If it is the plugin's own `extensions.<id>.key` (the common case) it is covered: use prefs.get(\"key\"). Zotero's own or Firefox prefs have no Zinc equivalent: map each to a Zinc setting or drop."),
	R("prefs", "pref observers", /Zotero\.Prefs\.(?:registerObserver|unregisterObserver)|Services\.prefs\.addObserver/, "covered", "prefs.observe + events.on-pref-changed", "lifecycle 45"),
	R("prefs", "default prefs file", /^\s*pref\(\s*["'][\w.-]+["']\s*,/m, "covered", "manifest default_prefs", "lifecycle 11"),
	R("prefs", "per-window prefs", /Zotero\.Prefs\.(?:getForWindow|setForWindow|observeForWindow)/, "not planned", "keep your own per-window state keyed by window-id", "lifecycle 47"),
	R("prefs", "preference pane registration", /Zotero\.PreferencePanes\.(?:register|unregister)/, "covered", "extend.register-pref-pane (rows, or a ui tree view)", "extend 65-74"),
	R("prefs", "XUL preference bindings", /<preference\b|\bpreference\s*=\s*["']|<prefpane\b|\bdata-preference\b/, "covered", "extend.setting-row (toggle, text, number, choice) bound to a pref", "extend 70"),
	R("prefs", "pane stylesheets / scripts / XHTML", /<(?:vbox|hbox|groupbox|html:|checkbox|menulist|radiogroup|textbox)\b|stylesheets\s*:|\bdefaultXUL\b|\bscripts\s*:\s*\[/, "partial", "pane-content.rows or pane-content.view (ui tree); no XUL, no CSS", "extend 66-69"),
	R("prefs", "open prefs", /openPreferences|Zotero\.Utilities\.Internal\.openPreferences/, "covered", "extend.open-settings", "extend 73"),
	R("prefs", "secrets in prefs / login manager", /Services\.logins|nsILoginManager|LoginInfo/, "covered", "secrets.get / set / delete", "lifecycle 110"),

	// ---- l10n ----------------------------------------------------------------------------------------------------
	R("l10n", "Fluent in DOM", /data-l10n-id|data-l10n-args|document\.l10n|\bnew\s+Localization\b|insertFTLIfNeeded|MozXULElement\.insertFTL/, "covered", "localized-string {id,args,fallback} in every UI type; manifest locales", "lifecycle 49; ui: data-l10n-id"),
	R("l10n", "getString / formatValue", /\bgetString\s*\(|l10n\.formatValue|formatMessages?\b|Zotero\.getString|getLocalizedString|stringBundle/, "partial", "l10n.format / format-many (own .ftl); Zotero's own strings are not available", "lifecycle 49, 52", "Anything that asks for a built-in Zotero string must ship its own."),
	R("l10n", "locale", /Services\.locale|requestedLocales|Zotero\.locale/, "covered", "l10n.locale, events.on-locale-changed", "lifecycle 53"),
	R("l10n", ".properties / .dtd strings", /\.properties\b|\.dtd\b|&\w+\.\w+;/, "partial", "convert to .ftl", "lifecycle 49", "Zotero 7-10 plugins can still use .dtd/.properties; Zinc reads Fluent only."),

	// ---- menus ---------------------------------------------------------------------------------------------------
	R("menus", "MenuManager", /Zotero\.MenuManager\.(?:registerMenu|unregisterMenu)/, "covered", "extend.register-menu (+ on-menu-showing, on-menu-command)", "extend 41-64"),
	R("menus", "toolkit menu", /ztoolkit\.Menu\.(?:register|unregister|registerAll)|MenuManager/, "covered", "extend.register-menu", "extend 109"),
	R("menus", "DOM-injected menus", /getElementById\(\s*["'](?:zotero-itemmenu|zotero-collectionmenu|menu_ToolsPopup|menu_FilePopup|menu_EditPopup|menu_viewPopup|menu_goPopup|menu_HelpPopup|zotero-tb-add-attachment|zotero-tb-note-add|zotero-reader-menu|zotero-tab-menu)|createXULElement\(\s*["'](?:menuitem|menu|menupopup|menuseparator)|["']popupshowing["']/, "covered", "extend.register-menu with a menu-target (library-item, library-collection, menubar-tools, ...)", "extend 41-52, 109", "Rewrite as data; visibility via visible-when / on-menu-showing."),
	R("menus", "toolbar buttons", /zotero-items-toolbar|zotero-tabs-toolbar|toolbarbutton|createXULElement\(\s*["']toolbarbutton/, "partial", "extend.register-toolbar-button / register-toolbar-view (two slots)", "extend 110"),
	R("menus", "keyboard shortcuts / key events", /addEventListener\(\s*["']key(?:down|up|press)["']|ztoolkit\.Keyboard|KeyboardManager|<key\b|\bkeyboardEvent\b/, "partial", "extend.register-shortcut (named command, one chord, user-rebindable) + on-shortcut", "extend 111", "No raw key events, no key sequences, no overriding built-in shortcuts. A 'press key to record' UI becomes the host's shortcut settings."),
	R("menus", "command palette / prompt", /ztoolkit\.Prompt|PromptManager/, "partial", "ui.open-dialog / popover with text-input + list", "extend 112"),

	// ---- columns / item pane -------------------------------------------------------------------------------------
	R("item tree", "ItemTreeManager column", /Zotero\.ItemTreeManager\.(?:registerColumns?|unregisterColumns?|refreshColumns)/, "covered", "extend.register-column + extend-handlers.on-column-values (batched)", "extend 25-40"),
	R("item tree", "column renderCell / htmlLabel / iconLabel", /\b(?:renderCell|htmlLabel|iconLabel)\b/, "partial", "cell.body (text, icon, bar, rating, chips), cell.color/style/tooltip; label + icon", "extend 32, 35", "No DOM in a cell. Check that the rendering fits one of the closed cell kinds."),
	R("item tree", "item tree patches / row styling", /ItemTree\.prototype|itemsView\.|ZoteroPane\.itemsView|collectionsView|getRowProperties|\.rowProperties/, "partial", "extend.register-row-style, register-collection-decoration, register-virtual-collection", "extend 117-119", "Replacing ItemTree behaviour is not portable: use the registrations."),
	R("item tree", "ItemPaneManager section", /Zotero\.ItemPaneManager\.(?:registerSection|unregisterSection)/, "covered", "extend.register-section + ui-events.mount/update-context (JSON tree)", "extend 1-18"),
	R("item tree", "section body DOM", /bodyXHTML|\bonRender\b|\bonAsyncRender\b|\bonItemChange\b|\bsectionButtons\b|\bsetSectionSummary\b/, "partial", "mount/update-context return a ui tree; ui.push for async; view-meta for summary and buttons", "extend 4-14"),
	R("item tree", "info rows", /Zotero\.ItemPaneManager\.(?:registerInfoRow|unregisterInfoRow|refreshInfoRow)/, "covered", "extend.register-info-row + on-info-row-get / -set", "extend 19-24"),
	R("item tree", "item pane DOM", /ZoteroPane\.itemPane|item-pane|zotero-view-item|itembox|item-box|ZoteroContextPane|zotero-item-pane/, "partial", "sections, info rows, ui embed.item-box", "extend 126; ui: item pane"),

	// ---- notifier ------------------------------------------------------------------------------------------------
	R("notifier", "Notifier observer", /Zotero\.Notifier\.(?:registerObserver|unregisterObserver)/, "covered", "notifier.subscribe + notifier-handler.on-events (batches, ids are keys)", "library: Notifier", "Check the observed types: file/open, tab, itemtree, itempane, infobox, feed are not item events."),
	R("notifier", "Notifier types (file/tab/itempane/...)", /registerObserver\([\s\S]{0,200}?\[\s*["'](?:file|tab|itemtree|itempane|infobox|feed|feedItem|bucket|share|api-key)["']/, "partial", "file/open -> reader.subscribe(opened); tab -> extend.subscribe-events; the rest not planned", "library: Notifier; reader 52; extend 84, 125"),
	R("notifier", "Notifier.trigger", /Zotero\.Notifier\.(?:trigger|begin|commit|queue)/, "partial", "notifier.trigger (other/UI types only); begin/commit not planned", "library: Notifier"),
	R("notifier", "skipNotifier / skipSelect", /skipNotifier|skipSelect|skipAutoSync|skipDateModifiedUpdate/, "partial", "apply-options.skip-notify; the others have no equivalent", "library: Items, Notifier"),

	// ---- items / library / DB ------------------------------------------------------------------------------------
	R("library", "Items get/query", /Zotero\.Items\.(?:get|getAsync|getAll|getByLibraryAndKey|getTopLevel|keepTopLevel|keepParents|getDeleted)\b/, "covered", "library.get-items / query-items / query-keys; numeric itemID does not exist (keys do)", "library: Items"),
	R("library", "item read/write (get/setField, saveTx)", /\.(?:getField|setField|getCreators|setCreators|getTags|addTag|removeTag|setTags|saveTx|save|eraseTx|erase|setNote|getNote|toJSON|fromJSON|setType|addRelatedItem)\s*\(/, "covered", "item JSON from get-items; changes through library.apply (update-item patch, add-tags, ...)", "library: Items, Tags", "The object model goes away: a plugin edits JSON and sends one atomic batch."),
	R("library", "item type predicates", /\.(?:isRegularItem|isNote|isAttachment|isTopLevelItem|isInTrash|isAnnotation|isFileAttachment|isPDFAttachment|numChildren|getAttachments|getNotes|getBestAttachment|topLevelItem|parentID)\b/, "covered", "itemType / parentItem / deleted in item JSON; item-summary.best-attachment; attachments.get-info", "library: Items, Attachments"),
	R("library", "numeric item ids", /\bitemIDs?\b|\blibraryID\b|\buserLibraryID\b|\bitem\.id\b/, "partial", "item-key (8-char string) and library-id", "library: Items", "Zinc has no numeric itemID: translate ids to keys."),
	R("library", "duplicates / merge / trash", /Zotero\.(?:Items\.(?:merge|trash|emptyTrash|erase)|Duplicates)/, "covered", "library.merge-items, find-duplicates, apply trash-items / restore-items / erase-items, empty-trash", "library: Items"),
	R("library", "Collections", /Zotero\.Collections\.|\.(?:addToCollection|removeFromCollection|getCollections|getChildCollections)\b|ZoteroPane\.getSelectedCollection/, "covered", "library.list-collections, get-collection-items, apply create-/update-/erase-collection, add-to-collection", "library: Collections"),
	R("library", "Tags", /Zotero\.Tags\.|\.(?:addTag|removeTag|hasTag|replaceTag|removeAllTags)\s*\(/, "covered", "library.list-tags, rename-tag, delete-tags; apply add-tags / remove-tags; tag-kind", "library: Tags"),
	R("library", "Searches", /new\s+Zotero\.Search\b|Zotero\.Searches\.|\.addCondition\s*\(|Zotero\.SearchConditions/, "partial", "library.query-items with item-query / search-definition; saved searches via apply", "library: Searches", "The core compiler supports a subset of the 59 condition names."),
	R("library", "raw SQL: Zotero.DB", /Zotero\.DB\.(?:queryAsync|valueQueryAsync|rowQueryAsync|columnQueryAsync|queryTx|executeTransaction|query|valueQuery|columnQuery|rowQuery)/, "not planned", "query-items / query-keys / count-items / facets / list-tags for reads; library.apply for writes", "library: Raw database", "No SQL. Rewrite the intent, not the statement. Aggregates: library.facets (one field per call)."),
	R("library", "DB schema / transactions", /Zotero\.DB\.(?:tableExists|columnExists|addCallback|observe|vacuum|backupDatabase|inTransaction|requireTransaction|waitForTransaction)/, "not planned", "library.apply is the only atomic unit (no interactive transactions)", "library: Raw database"),
	R("library", "Relations", /Zotero\.Relations\.|\.(?:getRelations|addRelation|removeRelation|setRelations|getLinkedItem)\b/, "partial", "apply add-related / remove-related; relations JSON in item data; find-by-relation (needs core)", "library: Items"),
	R("library", "Libraries / groups", /Zotero\.(?:Libraries|Groups)\b/, "covered", "library.list-libraries (library-id 1 is the user library)", "library: Libraries"),
	R("library", "schema / item fields", /Zotero\.(?:ItemTypes|ItemFields|CreatorTypes|Creators)\b/, "partial", "schema.get-schema; creators live inside item JSON (no creator table)", "library: Schema"),
	R("library", "attachments", /Zotero\.Attachments\.|\.(?:getFilePath|getFilePathAsync|getFile|fileExists|getAttachmentLinkMode|attachmentContentType|renameAttachmentFile|relinkAttachmentFile)\b/, "covered", "attachments.* (get-info, read-file, import-bytes, import-from-url, link-file, rename-file, replace-file, ...)", "library: Attachments", "File paths need library.files.paths; prefer read-file / import-bytes."),
	R("library", "full text", /Zotero\.Fulltext\./, "partial", "fulltext.get-content / search / get-index-state / set-content / reindex", "library: Full text"),
	R("library", "cite / styles / quick copy", /Zotero\.(?:Styles|Cite|QuickCopy)\b/, "partial", "cite.list-styles, format, quick-copy", "library: Cite"),
	R("library", "translators", /Zotero\.(?:Translate|Translators)\b/, "partial", "translate.import-text / export-items / lookup / web", "library: Translate"),
	R("library", "sync", /Zotero\.Sync\b|Zotero\.SyncedSettings|Zotero\.Sync\.Runner/, "partial", "sync-control.sync-now / get-state; internals not planned", "library: Sync"),
	R("library", "utilities (dates, CSL, ids)", /Zotero\.Date\.|Zotero\.Utilities\.Item\.|Zotero\.Utilities\.(?:cleanDOI|cleanISBN|extractIdentifiers|capitalizeTitle|text2html|unescapeHTML|semverCompare)|Zotero\.Utilities\.Internal\.extractExtraFields/, "partial", "data-utils.* and util.*; generic string helpers move into the plugin", "library: Cite, Translate, Sync, utilities; lifecycle 107"),
	R("library", "Extra field parsing", /getField\(\s*["']extra["']\s*\)|setField\(\s*["']extra["']|extractExtraFields/, "covered", "data-utils.parse-extra; write `extra` in an update-item patch", "library: Items"),
	R("library", "feeds / retractions / reports", /Zotero\.(?:Feeds|FeedItems|FeedReader|Retractions|Report|Timeline)\b/, "not planned", "none (Zinc has no feeds)", "library: last rows"),

	// ---- network -------------------------------------------------------------------------------------------------
	R("net", "Zotero.HTTP", /Zotero\.HTTP\.(?:request|download|doGet|doPost|doHead|promise|processDocuments|loadDocuments|browserIsOffline)/, "covered", "net.send / download (declare permissions.net.hosts)", "lifecycle 56-75", "processDocuments / responseType document: no DOM, parse HTML in the guest."),
	R("net", "fetch / XHR", /(?<![\w.])fetch\s*\(|new\s+XMLHttpRequest|\.\s*responseType\s*=/, "covered", "net.send (bytes in, bytes out)", "lifecycle 56-59, 70"),
	R("net", "streaming fetch", /response\.body\.getReader|getReader\s*\(/, "covered", "net.send-streamed + body-reader", "lifecycle 69"),
	R("net", "WebSocket / SSE", /new\s+WebSocket|new\s+EventSource/, "not planned", "none in 0.1; SSE can be read with send-streamed", "lifecycle 71"),
	R("net", "proxies / cookies / auth", /Zotero\.Proxies|checkSecurity|newCookieContext|userContextId|onAuthorizationHeader/, "partial", "net cookie-mode jar(name) only; proxies not planned", "lifecycle 63, 74"),

	// ---- files / shell / clipboard / timers ---------------------------------------------------------------------
	R("files", "IOUtils / OS.File / Zotero.File", /\bIOUtils\.|\bPathUtils\.|\bOS\.(?:File|Path)\b|Zotero\.File\.|Zotero\.getTempDirectory|Zotero\.getStorageDirectory|Zotero\.DataDirectory|Zotero\.Profile/, "partial", "fs.* on roots data / bundled / temp / granted (relative paths); library files via attachments.*", "lifecycle 76-90", "No absolute paths. A path the user typed becomes a picker (fs.pick-*) or an attachment call."),
	R("files", "file pickers", /\bFilePicker\b|nsIFilePicker|FilePickerHelper/, "covered", "fs.pick-open / pick-save / pick-directory -> file-grant", "lifecycle 89"),
	R("files", "nsIFile / zip / subprocess", /nsIFile|nsIZipWriter|ZipReader|Zotero\.File\.zipDirectory|createInstance\(Ci|\bsubprocess\b|nsIProcess|Zotero\.Utilities\.Internal\.exec|launchFileWithApplication|nativeMessaging/, "not planned", "none (zip in the guest; no process spawning)", "lifecycle 87-88, 102"),
	R("shell", "launchURL / launchFile / reveal", /Zotero\.launchURL|Zotero\.launchFile|Zotero\.File\.reveal|openLink|Services\.(?:external|)protocol/, "covered", "shell.open-url / open-file (partial) / reveal", "lifecycle 99-101"),
	R("clipboard", "clipboard", /copyTextToClipboard|nsIClipboard|navigator\.clipboard|Clipboard\b|nsITransferable/, "covered", "clipboard.write / clipboard.read (permissions)", "lifecycle 97-98"),
	R("timers", "timers", /\b(?:setTimeout|setInterval|clearTimeout|clearInterval|requestIdleCallback|cancelIdleCallback)\s*\(|Zotero\.Promise\.delay/, "covered", "timers.set-timeout / set-interval / request-idle / sleep + events.on-timer", "lifecycle 91-95", "Callbacks come back as events.on-timer; closures over state become a table keyed by timer id."),
	R("timers", "workers / threads", /new\s+(?:Chrome)?Worker\s*\(|PromiseWorker|Services\.tm/, "not planned", "none: split work into steps (compute-heavy: write the plugin in Rust)", "lifecycle 96"),
	R("timers", "crypto / encoding", /crypto\.(?:getRandomValues|randomUUID|subtle)|Zotero\.Utilities\.Internal\.md5|\bmd5\b|DOMParser|XMLSerializer|TextEncoder|TextDecoder|\bBlob\b|FileReader/, "partial", "util.random-bytes / uuid-v4 / hash; others are the guest language's own libraries", "lifecycle 108-109"),
	R("timers", "debug logging", /Zotero\.(?:debug|logError|warn)\b|ztoolkit\.log|Zotero\.Debug\b/, "covered", "log.write / write-error", "lifecycle 103-106"),

	// ---- ui: prompts, dialogs, windows ---------------------------------------------------------------------------
	R("ui", "prompts / alerts", /Services\.prompt\.(?:alert|confirm|confirmEx|prompt|select)|Zotero\.alert|Zotero\.Prompt\.confirm|\balert\s*\(|\bconfirm\s*\(/, "covered", "ui.open-dialog (non-blocking, close event), ui.alert / confirm / prompt", "extend 102-103; ui: Services.prompt", "The call no longer returns the answer: continue in the close handler."),
	R("ui", "progress window", /ProgressWindow|ztoolkit\.ProgressWindow|ProgressWindowSet|ItemProgress/, "covered", "ui.show-toast / update-toast / close-toast", "extend 104-105"),
	R("ui", "progress queue", /ProgressQueue/, "not planned", "build with ui.open-dialog + update-dialog", "extend 106"),
	R("ui", "custom dialogs / windows", /window\.openDialog|openWindowByType|Services\.ww\.openWindow|ztoolkit\.Dialog|DialogHelper|SettingsDialog|\.open\(\s*["']chrome:/, "partial", "ui.open-dialog / open-window with a ui tree (not XHTML)", "extend 107, 113; ui: openDialog"),
	R("ui", "banners / item pane messages", /Zotero\.Banners|setItemsPaneMessage|setPaneMessage/, "partial", "extend.show-banner; item-pane message not planned", "extend 100-101"),
	R("ui", "tabs", /Zotero_Tabs\b|\.addLibraryTab|tabHooks/, "covered", "extend.open-tab / select-tab / list-tabs (+ ui-events.mount); addLibraryTab not planned", "extend 75-88"),
	R("ui", "selection / view", /getSelectedItems|getSelectedCollections|getSelectedSavedSearches|getSelectedLibraryIDs|getCollectionTreeRows|selectItems?\(|getSortedItems|getSortField|viewAttachment|viewItems|toggleItemPane/, "covered", "extend.get-context / list-selected-items / get-view / select-items / open-item", "extend 89-98", "Selection comes in the callback `context` (keys, not objects)."),
	R("ui", "VirtualizedTable / React", /VirtualizedTable|React\.createElement|ReactDOM|\bjsx\b|\.tsx\b/, "covered", "ui list-view / table nodes with render-range", "extend 114; ui: VirtualizedTable"),
	R("ui", "guide / tours", /GuideHelper|ztoolkit\.Guide/, "not planned", "popover or banner", "extend 123"),

	// ---- DOM / Firefox internals ---------------------------------------------------------------------------------
	R("dom", "createElement / createXULElement", /\.createElement(?:NS)?\s*\(|createXULElement|MozXULElement|ztoolkit\.UI\.|ztoolkit\.createXULElement|ztoolkit\.UI\.createElement/, "not planned", "none: build a ui tree (JSON) in an extension point", "ui: DOM rows; extend 115", "Every DOM construction must be redesigned as a tree."),
	R("dom", "query / mutate the host DOM", /getElementById\s*\(|querySelector(?:All)?\s*\(|\.appendChild\s*\(|\.insertBefore\s*\(|\.append\s*\(|\.remove\s*\(\s*\)|\.setAttribute\s*\(|\.classList\.|\.innerHTML|\.textContent\s*=|\.style\.\w+\s*=/, "not planned", "none for Zotero's own windows; extension points instead", "ui: Direct DOM edits; extend 115", "Hits inside a plugin-owned XHTML pane are redesigned as a ui tree; hits on Zotero's own elements are not portable."),
	R("dom", "DOM events", /addEventListener\s*\(\s*["'](?!key)/, "partial", "ui event-kind + event-binding on your own nodes; none on host elements", "ui: DOM events"),
	R("dom", "injected CSS / stylesheets", /<style\b|<link\b[^>]*stylesheet|\.css\b|adoptedStyleSheets|insertCSS|createProcessingInstruction\(\s*["']xml-stylesheet/, "partial", "named-style / style on your own nodes; ui.set-theme-override (colour tokens only)", "ui: CSS rows"),
	R("dom", "custom elements / fonts", /customElements\.define|@font-face|@keyframes/, "not planned", "functions that return subtrees; no custom fonts in v1", "ui: customElements, @font-face"),
	R("dom", "iframes / browsers / canvas", /<iframe|<browser\b|createElement\(\s*["'](?:iframe|browser|canvas)|\.getContext\(\s*["']2d/, "partial", "ui web-view (permission ui.webview) / canvas draw list", "ui: iframe, canvas rows"),
	R("dom", "drag and drop", /["'](?:dragstart|dragover|drop)["']|Zotero\.DragDrop|nsIDragService/, "partial", "extend.register-drop-target / register-drag-format; ui draggable + drop-target", "extend 120-121"),

	// ---- reader --------------------------------------------------------------------------------------------------
	R("reader", "Reader event listeners", /Zotero\.Reader\.(?:registerEventListener|unregisterEventListener)/, "covered", "reader.register-listener (slot or menu) + reader-events (needs reader.ui)", "reader 1-15"),
	R("reader", "Reader instances", /Zotero\.Reader\.(?:getByTabID|_readers|open|openURI|openPreview)|ReaderTab|\breader\.(?:navigate|focus|close|setTool|findNext|zoom\w*)/, "covered", "reader.list-readers / get-reader-by-tab / open / navigate / run-command / set-tool / find", "reader 16-47"),
	R("reader", "reader internals / iframe", /_internalReader|_iframeWindow|_lastView|_selectionPopup|PDFViewerApplication|\bpdfDocument\b/, "not planned", "reader.get-selection / get-page-text / render-page / register-overlay / ...", "reader 55-67, 'What plugins use ...' table", "The biggest rewrite: each use has a typed replacement, or none."),
	R("reader", "toolkit reader helpers", /ztoolkit\.Reader|ReaderTabPanel|ztoolkit\.ReaderTabPanel|getReader\(\)/, "partial", "reader.* (selected-reader, register-panel)", "reader 18; reader table"),
	R("reader", "annotations", /Zotero\.Annotations\b|annotationType|annotationText|annotationComment|annotationColor|annotationPosition|getAnnotations\s*\(/, "covered", "annotations.list / create / update / remove (permissions annotations.read/write)", "reader 69-85"),
	R("reader", "note editor / notes", /Zotero\.Notes\.|EditorInstance|noteEditor|note-editor|ZoteroContextPane\.activeEditor|insertAnnotations|_postMessage\s*\(\s*\{\s*action/, "partial", "note-editor.* (insert-html, insert-annotations, register-head, ...)", "reader 86-103"),
	R("reader", "PDF worker / renderer", /Zotero\.PDFWorker|Zotero\.PDFRenderer/, "partial", "reader.get-page-text / render-page; annotations.import-embedded-annotations", "reader 51, 60-61, 84"),

	// ---- monkey-patching / internals -----------------------------------------------------------------------------
	R("patching", "monkey-patching", /\b(?:\$?patch\$?|monkeyPatch|ztoolkit\.patch|PatchHelper|MonkeyPatch)\s*\(|\bwrapMethod\b|\.prototype\.\w+\s*=\s*(?:async\s*)?function|(?:Zotero|ZoteroPane|ItemTree|Zotero_Tabs|Zotero\.\w+)(?:\.\w+)*\.\w+\s*=\s*(?:async\s*)?(?:function|\()/, "not planned", "none: find the extension point that covers the intent, or report the feature as not portable", "extend 122; ui: CSS/DOM rows", "See references/patterns.md, 'Monkey-patching'."),
	R("patching", "export / serialization patches", /itemToExportFormat|Zotero\.Utilities\.Internal\.\w+\s*=|Translate\.ItemGetter|Zotero\.Translate\.\w+\.prototype/, "not planned", "none (export runs in the core's translator sandbox); filter in translate.export-items output", "library: Translate"),
	R("patching", "getField / Item.prototype hooks", /Zotero\.Item\.prototype|Zotero\.Items\.\w+\s*=|Zotero\.Collection\.prototype/, "not planned", "virtual fields: info row or column", "extend 122"),
	R("patching", "private / internal fields", /\b_\w+Window\b|\._tabs\b|\._readers\b|\.itemsView\._|ztoolkit\.getGlobal/, "not planned", "none", "extend 124"),

	// ---- Zotero-version specific (7 to 11) ---------------------------------------------------------------------
	R("zotero version", "Zotero 10: singular selection getters (THROW in Zotero 10)", /\b(?:getCollectionTreeRow|getSelectedLibraryID|getSelectedCollection|getSelectedSavedSearch|getSelectedGroup)\s*\(|\.collectionTreeRow\b/, "covered", "extend ctx.rows (list of tree-row, may hold several) and ctx.library; view kind via extend.get-view", "extend 90", "Zotero 10 has multi-select in the collection tree, so these calls throw there: the plugin is already broken on 10. In Zinc read ctx.rows (plural) and decide what several rows mean."),
	R("zotero version", "Zotero 10: collection tree row in menu contexts", /collectionTreeRows?\b[\s\S]{0,80}?(?:main\/library|context)|context\.collectionTreeRow\b/, "covered", "menu-entry callback ctx.rows", "extend 59, 90"),
	R("zotero version", "Zotero 10: items list rows (isObjectRow)", /\bisObjectRow\b|itemsView\.viewMode|\.viewMode\b/, "partial", "extend.get-view (row kind) and ctx.items; no live view object", "extend 91, 99"),
	R("zotero version", "Zotero 10: CookieSandbox / HTTP.download Response", /Zotero\.CookieSandbox|CookieSandbox\(|newCookieContext/, "partial", "net cookie-mode jar(name) (isolated jar); CookieSandbox does not exist in Zotero 10 either", "lifecycle 63"),
	R("zotero version", "Zotero 10: undo history / saveTx undoAction", /UndoHistory|undoAction/, "not planned", "none (the host owns undo); a library.apply batch is atomic", "library: Items"),
	R("zotero version", "Zotero 10: full-text word tables / fulltextWord", /fulltextWords?\b|fulltextItemWords|\bfulltextWord\b/, "partial", "fulltext.search; condition fulltextContent (fulltextWord was removed in Zotero 10)", "library: Full text"),
	R("zotero version", "Zotero 10: ftl resource ids", /Zotero\.ftl\.(?:addResourceIds|removeResourceIds)|\.ftl\.addResourceIds/, "covered", "manifest locales; l10n", "lifecycle 12"),
	R("zotero version", "Zotero 8: Bluebird helpers (removed in 8)", /Zotero\.Promise\.(?:map|filter|each|all|coroutine|method|using)\b|Zotero\.spawn\b|Zotero\.Promise\.defer\b/, "partial", "plain async/await (Promise.all); timers.sleep for delay", "lifecycle 94", "Zotero.Promise.map/filter/each and Zotero.spawn no longer exist in Zotero 8+."),
	R("zotero version", "Zotero 8: .jsm modules (now .mjs / .sys.mjs)", /\.jsm["'\x60]|Cu\.import\s*\(|ChromeUtils\.import\s*\(/, "not planned", "none: import npm / local modules into the bundle", "lifecycle 112"),
	R("zotero version", "Zotero 11 (pre-release): ownerGlobal / async login manager", /\.ownerGlobal\b|\.documentGlobal\b/, "not planned", "none (DOM)", "lifecycle 112"),
	R("zotero version", "Zotero 10: local server on 23119 (needs a localhost Host header)", /\b23119\b|\b23120\b|127\.0\.0\.1:2311|localhost:2311/, "not planned", "none: Zinc refuses ports 23119 and 23120; use library.* instead of the Zotero HTTP API", "lifecycle 75", "Plugins that talk to Zotero's own local API (connector or local-API clients) must use the library interface."),

	// ---- misc ----------------------------------------------------------------------------------------------------
	R("misc", "toolkit usage (zotero-plugin-toolkit)", /zotero-plugin-toolkit|\bztoolkit\b|\bBasicTool\b|\bUITool\b/, "partial", "see each ztoolkit.* rule: it wraps APIs mapped above", "extend 109-124"),
	R("misc", "Zotero.Utilities generic helpers", /Zotero\.Utilities\.(?:trim|cleanTags|xpath|parseURL|htmlSpecialChars|strToDate|lpad|capitalize|removeDiacritics|getVersion)/, "not planned", "re-implement in the plugin (generic code)", "library: Cite, Translate, Sync, utilities"),
	R("misc", "Zotero.Utilities.Internal", /Zotero\.Utilities\.Internal\.\w+/, "partial", "case by case: openPreferences, md5, copyTextToClipboard have rows; others are internals", "lifecycle 99-108"),
	R("misc", "Services.* (Firefox)", /Services\.(?!prompt\b|prefs\b|locale\b|logins\b|appinfo\b|scriptloader\b|startup\b|wm\b|io\b|console\b|appShell\b)\w+/, "not planned", "none unless a rule above names it", "lifecycle 111"),
];

// ---------------------------------------------------------------------------------------------------------------------
// File loading: .xpi / .zip (own zip reader, node:zlib only) or a directory.
// ---------------------------------------------------------------------------------------------------------------------
interface SrcFile {
	path: string; // forward slashes, relative to the plugin root
	bytes: number;
	text?: string; // only for text files we scan
}

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".jsm", ".ts", ".tsx", ".jsx", ".xhtml", ".xul", ".html", ".htm", ".css", ".ftl", ".json", ".properties", ".dtd", ".md", ".txt", ".yml", ".yaml", ".toml", ".xml", ".rdf", ".manifest"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".scaffold", "dist", "build", ".github", "typings"]);
const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|\.min\.js)$/;

function readZip(buf: Buffer): SrcFile[] {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out: SrcFile[] = [];
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const usize = buf.readUInt32LE(p + 24);
		const nlen = buf.readUInt16LE(p + 28);
		const elen = buf.readUInt16LE(p + 30);
		const clen = buf.readUInt16LE(p + 32);
		const lho = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nlen);
		p += 46 + nlen + elen + clen;
		if (name.endsWith("/")) continue;
		const f: SrcFile = { path: name, bytes: usize };
		if (TEXT_EXT.has(extname(name).toLowerCase()) && !SKIP_FILE.test(name)) {
			const lnlen = buf.readUInt16LE(lho + 26);
			const lelen = buf.readUInt16LE(lho + 28);
			const data = buf.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
			f.text = (method === 0 ? data : inflateRawSync(data)).toString("utf8");
		}
		out.push(f);
	}
	return out;
}

function readDir(root: string): SrcFile[] {
	const out: SrcFile[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIR.has(e.name)) walk(full);
				continue;
			}
			const rel = relative(root, full).split(sep).join("/");
			const f: SrcFile = { path: rel, bytes: statSync(full).size };
			if (TEXT_EXT.has(extname(e.name).toLowerCase()) && !SKIP_FILE.test(rel) && f.bytes < 4_000_000) f.text = readFileSync(full, "utf8");
			out.push(f);
		}
	};
	walk(root);
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------------------------------
interface Hit {
	file: string;
	line: number;
	snippet: string;
}

function lineIndex(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}
function lineOf(starts: number[], pos: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function isScannedForApis(path: string): boolean {
	const ext = extname(path).toLowerCase();
	if (/\.(?:d\.ts)$/.test(path)) return false;
	return [".js", ".mjs", ".cjs", ".jsm", ".ts", ".tsx", ".jsx", ".xhtml", ".xul", ".html", ".htm", ".css"].includes(ext) || basename(path) === "prefs.js";
}

/**
 * An esbuild/rollup bundle marks each module with a comment line "// src/foo.ts" or "// node_modules/pkg/dist/x.js". Blank out the
 * node_modules parts (same length, so line numbers stay right) and return which packages were inside. Without markers (a minified
 * bundle) nothing is removed and the report may contain hits from the libraries; the summary says so.
 */
function stripBundledLibraries(text: string): { text: string; libs: Map<string, number> } {
	const marks = [...text.matchAll(/^[ \t]*\/\/ ((?:[\w@.-]+\/)*[\w@.-]+\.(?:[cm]?[jt]sx?|json|css))\r?$/gm)];
	const libs = new Map<string, number>();
	if (marks.length < 3) return { text, libs };
	let out = "";
	let last = 0;
	for (let i = 0; i < marks.length; i++) {
		const start = marks[i].index!;
		const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
		const path = marks[i][1];
		const nm = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
		out += text.slice(last, start);
		if (nm) {
			libs.set(nm[1], (libs.get(nm[1]) ?? 0) + (end - start));
			out += text.slice(start, end).replace(/[^\n]/g, " ");
		} else out += text.slice(start, end);
		last = end;
	}
	out += text.slice(last);
	return { text: out, libs };
}

const bundledLibs = new Map<string, number>();

function scan(files: SrcFile[]) {
	const hits = new Map<string, Hit[]>();
	const known = new Set<string>();
	const unknown = new Map<string, number>();
	for (const f of files) {
		if (!f.text || !isScannedForApis(f.path)) continue;
		const stripped = stripBundledLibraries(f.text);
		for (const [k, v] of stripped.libs) bundledLibs.set(k, (bundledLibs.get(k) ?? 0) + v);
		f.text = stripped.text;
		const starts = lineIndex(f.text);
		for (const rule of RULES) {
			// prefs.js default prefs are matched only in prefs.js; skip other-file noise for that rule
			if (rule.id === "default prefs file" && basename(f.path) !== "prefs.js") continue;
			const re = new RegExp(rule.re.source, rule.re.flags.replace("g", "") + "g");
			let m: RegExpExecArray | null;
			let guard = 0;
			while ((m = re.exec(f.text)) && guard++ < 5000) {
				if (m[0] === "") re.lastIndex++;
				const a = Math.max(0, m.index - 30);
				const hit: Hit = { file: f.path, line: lineOf(starts, m.index), snippet: oneLine(f.text.slice(a, m.index + Math.min(110, m[0].length + 60))) };
				const key = `${rule.area}\u0000${rule.id}`;
				(hits.get(key) ?? hits.set(key, []).get(key)!).push(hit);
				known.add(m[0].match(/Zotero\.\w+(?:\.\w+)?/)?.[0] ?? "");
			}
		}
		// every Zotero.X.y / Services.X mentioned, to find what no rule covers
		const names = f.text.matchAll(/\b(Zotero\.[A-Z]\w+(?:\.\w+)?|Services\.\w+)/g);
		for (const n of names) unknown.set(n[1], (unknown.get(n[1]) ?? 0) + 1);
	}
	// drop names that some rule already explains (compare by regex test)
	const unmapped: [string, number][] = [];
	for (const [name, count] of unknown) {
		const covered = RULES.some((r) => { const re = new RegExp(r.re.source, r.re.flags.replace("g", "")); return re.test(name) || re.test(name + ".x") || re.test(name + ".x("); });
		if (!covered) unmapped.push([name, count]);
	}
	unmapped.sort((a, b) => b[1] - a[1]);
	return { hits, unmapped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Facts about the package
// ---------------------------------------------------------------------------------------------------------------------
function facts(files: SrcFile[]) {
	const by = (re: RegExp) => files.find((f) => re.test(f.path));
	const json = (f?: SrcFile) => {
		try {
			return f?.text ? JSON.parse(f.text) : undefined;
		} catch {
			return undefined;
		}
	};
	const manifest = json(files.find((f) => /^(?:addon\/)?manifest\.json$/.test(f.path)));
	const pkg = json(files.find((f) => f.path === "package.json"));
	const license = by(/^(?:LICENSE|LICENCE|COPYING)(?:\.\w+)?$/i);
	const licenseText = license?.text?.slice(0, 600) ?? "";
	const licenseKind =
		/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(licenseText) ? "AGPL" :
		/GNU LESSER GENERAL PUBLIC/i.test(licenseText) ? "LGPL" :
		/GNU GENERAL PUBLIC LICENSE/i.test(licenseText) ? "GPL" :
		/Mozilla Public License/i.test(licenseText) ? "MPL" :
		/Apache License/i.test(licenseText) ? "Apache" :
		/Permission is hereby granted, free of charge/i.test(licenseText) ? "MIT" :
		/Redistribution and use in source and binary forms/i.test(licenseText) ? "BSD" : license ? "unrecognised (read it)" : undefined;
	const ftl = files.filter((f) => f.path.endsWith(".ftl"));
	const ftlMessages = ftl.reduce((n, f) => n + (f.text?.match(/^[A-Za-z][\w-]*\s*=/gm)?.length ?? 0), 0);
	const locales = [...new Set(ftl.map((f) => f.path.match(/locale\/([^/]+)\//)?.[1]).filter(Boolean))];
	const prefsJs = files.find((f) => basename(f.path) === "prefs.js" && /defaults\//.test(f.path) || f.path === "prefs.js" || f.path === "addon/prefs.js");
	const prefs = [...(prefsJs?.text?.matchAll(/^\s*(?:user_)?pref\(\s*["']([^"']+)["']\s*,\s*([^)]+)\)/gm) ?? [])].map((m) => `${m[1]} = ${m[2].trim()}`);
	const bundled = files.filter((f) => f.bytes > 60_000 && /\.(?:js|mjs)$/.test(f.path));
	const chrome = files.filter((f) => /\.(?:xhtml|xul|css)$/.test(f.path));
	const hasBootstrap = !!by(/(?:^|\/)bootstrap\.js$/);
	const legacy = !!by(/^install\.rdf$/) || !!by(/chrome\.manifest$/) && !hasBootstrap;
	return { manifest, pkg, license, licenseKind, ftlMessages, locales, prefs, bundled, chrome, hasBootstrap, legacy, fileCount: files.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--examples");
if (!target || flag("--help")) {
	console.error("usage: bun scan.ts <plugin.xpi | folder> [--json] [--examples N]");
	process.exit(target ? 0 : 2);
}
const examples = Number(opt("--examples", "2"));

const st = statSync(target);
const files = st.isDirectory() ? readDir(target) : readZip(readFileSync(target));
const info = facts(files);
const { hits, unmapped } = scan(files);

const statusOrder: Status[] = ["not planned", "partial", "covered"];
const rows = [...hits.entries()].map(([k, v]) => {
	const [area, id] = k.split("\u0000");
	const rule = RULES.find((r) => r.area === area && r.id === id)!;
	const nfiles = new Set(v.map((h) => h.file)).size;
	return { rule, hits: v, nfiles };
});

if (flag("--json")) {
	console.log(JSON.stringify({ target, facts: { ...info, manifest: info.manifest, pkg: undefined, license: info.license?.path, bundled: info.bundled.map((f) => f.path), chrome: info.chrome.map((f) => f.path) }, rules: rows.map((r) => ({ area: r.rule.area, id: r.rule.id, status: r.rule.status, ref: r.rule.ref, zinc: r.rule.zinc, count: r.hits.length, files: r.nfiles, examples: r.hits.slice(0, examples) })), unmapped }, null, 2));
	process.exit(0);
}

const out: string[] = [];
const p = (s = "") => out.push(s);
const z = info.manifest?.applications?.zotero ?? info.manifest?.applications?.gecko ?? {};
p(`# Zotero plugin inventory: ${info.manifest?.name ?? basename(target)}`);
p();
p(`Scanned \`${target}\` (${info.fileCount} files).`);
p();
p("## Package");
p();
p(`- id: \`${z.id ?? "?"}\`; version \`${info.manifest?.version ?? "?"}\`; Zotero ${z.strict_min_version ?? "?"} to ${z.strict_max_version ?? "?"} (Zinc ignores the max); manifest_version ${info.manifest?.manifest_version ?? "?"}${String(z.id ?? "").startsWith("__") ? " (build placeholders like __addonID__: a source repo; the real values are in package.json / the scaffold config)" : ""}`);
p(`- entry: ${info.hasBootstrap ? "bootstrap.js (Zotero 7+ style)" : info.legacy ? "LEGACY overlay (install.rdf / chrome.manifest, Zotero 6): it must be rewritten as bootstrap logic first, treat as a rewrite from the feature list" : "no bootstrap.js found (source repo? the scan covers src/ and addon/ anyway)"}`);
p(`- licence: ${info.licenseKind ?? "not in the package (read the repo or README; never port code that has no licence)"}${info.pkg?.license ? ` (package.json: ${info.pkg.license})` : ""}`);
p(`- default prefs (${info.prefs.length}): ${info.prefs.slice(0, 12).map((x) => `\`${x}\``).join(", ") || "none in prefs.js (check for code-side defaults: grep Prefs.set at startup)"}`);
p(`- Fluent: ${info.ftlMessages} messages in ${info.locales.length} locale(s) ${info.locales.length ? `(${info.locales.join(", ")})` : ""}`);
p(`- XHTML/XUL/CSS chrome files (${info.chrome.length}): ${info.chrome.map((f) => f.path).slice(0, 8).join(", ") || "none"}`);
if (bundledLibs.size) p(`- libraries bundled into the JS (skipped by the scan; what the plugin calls on them still shows up): ${[...bundledLibs].map(([k, n]) => `${k} (${Math.round(n / 1024)} KB)`).join(", ")}`);
p(`- big JS files (bundled libraries? > 60 KB): ${info.bundled.map((f) => `${f.path} (${Math.round(f.bytes / 1024)} KB)`).join(", ") || "none"}`);
const deps = info.pkg ? Object.keys({ ...info.pkg.dependencies, ...info.pkg.devDependencies }) : [];
if (deps.length) p(`- npm dependencies: ${deps.join(", ")}`);
p();

const tally: Record<Status, number> = { covered: 0, partial: 0, "not planned": 0 };
for (const r of rows) tally[r.rule.status]++;
p("## Summary");
p();
p(`${rows.length} API patterns found: **${tally.covered} covered**, **${tally.partial} partial**, **${tally["not planned"]} not planned** (a pattern counts once however often it is used; status is the rule's, so read the row for the exact caveat).`);
p();

for (const status of statusOrder) {
	const list = rows.filter((r) => r.rule.status === status);
	if (!list.length) continue;
	p(`## ${status === "not planned" ? "Not planned (blockers or redesigns)" : status === "partial" ? "Partial (behaviour changes)" : "Covered (ports cleanly)"}`);
	p();
	p("| Area | Pattern | Uses | Files | Zinc | Parity rows | Note |");
	p("|---|---|---|---|---|---|---|");
	for (const r of list.sort((a, b) => a.rule.area.localeCompare(b.rule.area))) {
		p(`| ${r.rule.area} | ${r.rule.id} | ${r.hits.length} | ${r.nfiles} | ${r.rule.zinc} | ${r.rule.ref} | ${r.rule.note ?? ""} |`);
	}
	p();
}

p("## Where each pattern appears");
p();
for (const r of rows.sort((a, b) => statusOrder.indexOf(a.rule.status) - statusOrder.indexOf(b.rule.status) || a.rule.area.localeCompare(b.rule.area))) {
	p(`- **${r.rule.area}: ${r.rule.id}** [${r.rule.status}]`);
	for (const h of r.hits.slice(0, examples)) p(`  - \`${h.file}:${h.line}\` ${h.snippet.slice(0, 140)}`);
	if (r.hits.length > examples) p(`  - ... ${r.hits.length - examples} more`);
}
p();
if (unmapped.length) {
	p("## Names no rule explains (look these up by hand in the parity tables)");
	p();
	p(unmapped.slice(0, 40).map(([n, c]) => `\`${n}\` (${c})`).join(", "));
	p();
}
p("## Next");
p();
p("Open each `not planned` and `partial` row in docs/developer-guide/wasm-plugins/*.md, decide what the feature does for the user, and write the go/no-go report (references/go-no-go.md). This list is a regex pass: it does not know which code paths are live.");
console.log(out.join("\n"));
