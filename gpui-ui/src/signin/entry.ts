// Imported FIRST by main.tsx. When the packaged exe is started through its zotero-next-signin.exe link with --signin-helper, this process is
// the sign-in browser helper (helper.ts) and not the app: it runs the helper and never lets main.tsx go on. In every other start it does
// nothing.
if (process.argv.includes("--signin-helper")) {
	const { main } = await import("./helper");
	await main();
	await new Promise<never>(() => {}); // the helper ends itself (process.exit) when the app asks it to or goes away
}

export {};
