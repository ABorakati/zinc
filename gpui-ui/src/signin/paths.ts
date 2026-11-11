// Where the sign-in browser keeps things. All of it is the app's own: nothing here points into the old Electrobun app's folders
// except OLD_PARTITION (read once by migrate.ts, never written).
import { join } from "node:path";
import { configDir, localDataDir } from "../../../core/src/platform-dirs";

/** The helper's exe name decides its WebView2 profile folder (see protocol.ts). */
export const SIGNIN_EXE = "zotero-next-signin.exe";
/** Tests run the helper under another exe name (ZN_SIGNIN_EXE_NAME), so their profile is not the user's. */
export const signinExeName = (): string => process.env.ZN_SIGNIN_EXE_NAME || SIGNIN_EXE;

const appData = (): string => configDir();
const localAppData = (): string => localDataDir();

/** The sign-in browser's WebView2 user data folder: %APPDATA%\zotero-next-signin.exe\EBWebView. */
export const signinProfileDir = (roaming = appData(), exe = signinExeName()): string => join(roaming, exe, "EBWebView");

/** Where the hard link of the app's exe lives (hard link: no extra disk space; a copy when the volume differs). */
export const helperDir = (local = localAppData()): string => join(local, "zotero-next-gpui", "signin");
export const helperExePath = (local = localAppData(), exe = signinExeName()): string => join(helperDir(local), exe);

/** Scratch folder for downloads the sign-in browser makes while a PDF is being captured (emptied after each capture). */
export const downloadsDir = (local = localAppData()): string => join(helperDir(local), "downloads");

/** The profile of the old Electrobun app's "institution" partition. Read-only source of the one-time migration. */
export const OLD_PARTITION = (local = localAppData()): string => join(local, "dev.zotero-next.app", "stable", "WebView2", "Partitions", "institution", "EBWebView");
