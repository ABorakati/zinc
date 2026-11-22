// The README.txt that goes into the Windows package (scripts/package.ts). Kept here so a test can read what users get.
// Backslashes are written twice: in a string a single one before a letter is dropped.
export function windowsReadme(): string {
	return [
		"Zinc (GPUI)",
		"",
		"Start zotero-next-gpui.exe. It does not need another Zinc: it opens the library itself (the one chosen on first run, or",
		"the one ZN_LIBRARY names), after making one backup copy (library.backup-gpui-*.sqlite next to it), and runs",
		"the same services: HTTP API on 127.0.0.1:23120 (Word add-in, MCP), Zotero Connector port 23119, two-way sync with",
		"Zotero (reading always, writing opt-in) and PDF full-text extraction.",
		"",
		"Do not run it together with another Zinc on the same library for sync: if port 23120 is taken, this app still opens the",
		"library but leaves Zotero sync and port 23119 to the other app (the sync indicator says so). Institution sign-in for",
		"Find Full Text opens a sign-in window of its own (a helper process started from a link to this exe, zotero-next-signin.exe in",
		"%LOCALAPPDATA%\\zotero-next-gpui\\signin; its WebView2 profile is %APPDATA%\\zotero-next-signin.exe\\EBWebView). ZN_SIGNIN=0 turns it off.",
		"",
		"Environment overrides: ZN_LIBRARY, ZN_DB (another database), ZN_URL (use an external core, run nothing here), ZN_PORT,",
		"ZN_SYNC=0, ZN_ZPORT=0|<port>, ZN_ZOTERO_DIR, ZN_PDF_DLL, ZN_PDFIUM_DLL, ZN_PDF_BACKEND=hayro (render with hayro instead of PDFium), ZN_ROOT, ZN_DOCWORKER_ENTRY, ZN_TRACE=1 (start-up timings).",
		"ZN_TRANSLATE_WORKER / ZN_ZOTERO_VENDOR / ZN_TRANSLATORS_DIR point the Zotero translators (import, export, web capture) at other copies.",
		"ZN_READER_HOST / ZN_NOTE_HOST point the core at other reader-host / note-host builds.",
		"HTML snapshots and EPUBs open in a web tab (Zotero's reader in a WebView2 window over the tab; needs the Microsoft Edge WebView2 runtime,",
		"preinstalled on Windows 11; its profile is %APPDATA%\\zotero-next-gpui.exe\\EBWebView).",
		"Settings and window state: %APPDATA%\\zotero-next-gpui\\",
		"",
	].join("\r\n");
}
