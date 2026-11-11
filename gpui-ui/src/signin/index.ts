// Find Full Text's institution sign-in browser: registers the bridge with the core (setBrowserBridge), so the core reports
// embeddedBrowser: true and opens the sign-in window itself. Nothing starts until a sign-in (or a cookie lookup for an existing session)
// needs the browser; see bridge.ts, helper.ts, protocol.ts.
//   ZN_SIGNIN=0   do not register the bridge (the core then offers the link for the user's own browser only)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setBrowserBridge } from "../../../core/src/fulltext/browser-bridge";
import { logInfo, logWarn } from "../../../core/src/log";
import { webViewSupported } from "../webview/host";
import { createSigninBridge, type SigninBridge } from "./bridge";
import { HelperLink } from "./launch";
import { migrateOldProfile } from "./migrate";
import { signinProfileDir } from "./paths";

export function registerSigninBridge(o: { packaged: boolean }): SigninBridge | null {
	// the helper drives WebView2 through the DevTools protocol, which WebKitGTK does not have: Windows only for now
	if (process.env.ZN_SIGNIN === "0" || process.platform !== "win32" || !webViewSupported()) return null;
	// the old app's sign-in, copied once (a few MB, in the background); the first start of the browser waits for it
	const migrated = Promise.resolve().then(() => {
		const r = migrateOldProfile();
		if (r.status === "copied") logInfo("core", "signin: the sign-in of the previous zotero-next was copied");
		else if (r.status === "failed" || r.status === "no-space") logWarn("core", `signin: the previous sign-in was not copied (${r.status})`);
		return r;
	});
	const bridge = createSigninBridge({
		start: async () => {
			await migrated;
			return HelperLink.start(o.packaged ? ["--signin-helper"] : [join(import.meta.dir, "helper.ts")]);
		},
		profileExists: () => existsSync(signinProfileDir()),
	});
	setBrowserBridge(bridge);
	return bridge;
}
