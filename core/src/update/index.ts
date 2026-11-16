// Auto-update: signed manifest, verified download, silent installer (Windows) or self-replacement (Linux AppImage, macOS Zinc.app). See ../../../gpui-ui/UPDATES.md for the whole flow.
export { compareVersions, displayVersion, isNewer, parseVersion } from "./version";
export type { ParsedVersion } from "./version";
export {
	UpdateError,
	canonicalBytes,
	generateKeyPair,
	publicKeyOf,
	signManifest,
	validateShape,
	verifyManifest,
	assertSecureUrl,
} from "./manifest";
export type { KeyPair, Manifest, PrivateJwk, UnsignedManifest, UpdateErrorCode } from "./manifest";
export { initialModel, installerName, planCleanup, reduce } from "./machine";
export type { LastCheck, UpdateEvent, UpdateModel, UpdateState } from "./machine";
export { createUpdater, installerArgs } from "./updater";
export type { UpdateEnv, UpdateSettings, Updater, UpdaterDeps } from "./updater";
export { createRealEnv, defaultUpdatesDir } from "./env";
export { currentPlatform, feedFileName, feedUrlFor, manifestPlatform } from "./platform";
export type { UpdatePlatform } from "./platform";
export { appImageReplace, detectSelfReplace, macAppReplace, macSwapScript, manualReplace, relaunchEnv } from "./replace";
export type { ReplaceDeps, SelfReplace } from "./replace";
