// Child process of e2e.test.ts: the "Install on exit" path with the REAL env. Check, download, arm install-on-exit, then quit normally
// the way the app does (a shutdown step that re-verifies, then process.exit(0) whose 'exit' event starts the installer detached).
// Config arrives as JSON in ZN_FIXTURE.
import { createRealEnv } from "../../src/update/env";
import { createUpdater } from "../../src/update/updater";

const c = JSON.parse(process.env.ZN_FIXTURE!) as {
	feedUrl: string;
	publicKey: string;
	updatesDir: string;
	version: string;
	exitCode: number;
};
const u = createUpdater({
	currentVersion: c.version,
	publicKey: c.publicKey,
	env: createRealEnv({ updatesDir: c.updatesDir }),
	settings: () => ({ enabled: true, autoDownload: false, feedUrl: c.feedUrl }),
});
process.on("exit", (code) => u.onExit(code));
await u.check({ manual: true });
await u.setInstallOnExit(true);
console.log("state:", u.model().state.kind, "installOnExit:", u.model().installOnExit);
await u.prepareForExit();
process.exit(c.exitCode);
