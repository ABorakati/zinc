// Non-document bridge methods for the Office.js add-in:
//   host.info, settings.get, settings.set, lib.search, lib.items, lib.byUri, lib.uriBase,
//   style.search, style.xml, locale.xml, zn.status, zn.lookup, zn.reveal, app.openUrl.
// Matches the exact parameters and return shapes of word/addin/Bridge.cs.

import type { CreateServiceMethods, HostContext, Methods } from "../contracts";
import { type FetchLike, createHttpClient } from "./http";
import {
	type CoreLibraryMeta,
	buildLibraryInfo,
	fetchLibraryMeta,
	getLibraryItems,
	lookupByUri,
	resolveUriBase,
	searchLibrary,
} from "./library";
import { openExternalUrl } from "./open-url";
import { type StorageBackend, createSettingsStore } from "./settings";
import { getLocaleXml, getStyleXml, searchStyles } from "./styles";
import { znLightStatus, znLookup, znReveal, znStatus } from "./zn";

export const ADDIN_VERSION = "0.1.0";

export interface ServiceOptions {
	/** Override settings persistence (default: Office.context.roamingSettings, else localStorage, else memory). */
	storage?: StorageBackend;
	/** Default Zinc API base URL when `apiBase` is not present in stored settings (default: http://127.0.0.1:23120). */
	defaultApiBase?: string;
	/** Custom fetch implementation for tests. */
	fetch?: FetchLike;
	/** Custom URL opener for tests. */
	openUrl?: (url: string) => void;
}

const LIGHT_META_TIMEOUT_MS = 800;

export function createServiceMethods(_ctx: HostContext, opts: ServiceOptions = {}): Methods {
	const settings = createSettingsStore({ storage: opts.storage, defaultApiBase: opts.defaultApiBase });
	const http = createHttpClient(() => settings.apiBase(), opts.fetch);

	return {
		"host.info": async (params = {}) => {
			const p = params ?? {};
			const light = p.light === true;
			const znPromise = light ? Promise.resolve(znLightStatus(http.apiBase())) : znStatus(http);
			let meta: CoreLibraryMeta | null;
			let metaErr: unknown;
			try {
				meta = await fetchLibraryMeta(http, !light, light ? LIGHT_META_TIMEOUT_MS : undefined);
			} catch (e) {
				meta = null;
				metaErr = e;
			}
			const [zn, uri] = await Promise.all([znPromise, resolveUriBase(http, settings, meta)]);
			return {
				version: ADDIN_VERSION,
				library: buildLibraryInfo(settings, http, meta, metaErr),
				uri,
				settings: settings.load(),
				zn,
			};
		},

		"settings.get": async () => settings.load(),
		"settings.set": async (params = {}) => settings.patchFromPage(params ?? {}),

		"lib.search": async (params = {}) => searchLibrary(http, params ?? {}),
		"lib.items": async (params = {}) => getLibraryItems(http, params ?? {}),
		"lib.byUri": async (params = {}) => lookupByUri(http, settings, params ?? {}),
		"lib.uriBase": async () => resolveUriBase(http, settings),

		"style.search": async (params = {}) => searchStyles(http, params ?? {}),
		"style.xml": async (params = {}) => getStyleXml(http, params ?? {}),
		"locale.xml": async (params = {}) => getLocaleXml(http, params ?? {}),

		"zn.status": async () => znStatus(http),
		"zn.lookup": async (params = {}) => znLookup(http, params ?? {}),
		"zn.reveal": async (params = {}) => znReveal(http, params ?? {}),
		"app.openUrl": async (params = {}) => openExternalUrl(params ?? {}, opts.openUrl),
	};
}

// Compile-time check that createServiceMethods satisfies the shared CreateServiceMethods seam.
const _assertContract: CreateServiceMethods = createServiceMethods;
void _assertContract;

export { CoreHttpError, ZincUnavailableError } from "./http";
export { dirOf, ftsMatchToQuery, identityAliases } from "./library";
export { validateExternalUrl } from "./open-url";
export { DEFAULT_API_BASE, PAGE_KEYS, SETTINGS_STORAGE_KEY } from "./settings";
