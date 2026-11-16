// Institutions: the built-in presets of the zotero-fulltext plugin (plugin/content/config.js INSTITUTIONS, each datum
// checked there on 2026-10-21 without signing in), the user's chosen institution (settings.institution) and what the
// engine's EngineConfig.institution and the sign-in warm-up derive from it. Nothing here is specific to one institution
// except the KCL preset, which stays the default only because it is the engine's default configuration.

export type SignInMethod = "openathens" | "saml" | "ezproxy";
export type LoginMode = "window" | "handoff";

/** What the user picks and edits (core/src/api-types.ts FullTextInstitution mirrors it). */
export interface InstitutionSettings {
	/** Preset id ("kcl", "ucl", ...), "other" for hand-entered details, "none" = open access only. */
	id?: string;
	name: string;
	/** Short slug, stable per institution; the sign-in realm of the warm-up. Derived from the id/name when absent. */
	realm?: string;
	/** OpenAthens organisation domain, e.g. "kcl.ac.uk". */
	openathensDomain?: string;
	/** Shibboleth / UK federation IdP entityID. */
	shibbolethEntityId?: string;
	/** Library proxy (EZproxy) login address, e.g. "https://login.kcl.idm.oclc.org" (a "/login?url=" tail is accepted). */
	proxyPrefix?: string;
	/** Absent = the host decides (a window when the app provides an embedded browser, else a hand-off link). */
	loginMode?: LoginMode;
}

export interface InstitutionPreset {
	id: string;
	name: string;
	methods: SignInMethod[];
	openathensDomain?: string;
	shibbolethEntityId?: string;
	proxyPrefix?: string;
}

/** EngineConfig.institution as the engine reads it. */
export interface EngineInstitution {
	name: string;
	openathens_domain: string;
	ezproxy: { login_host: string; suffix: string } | null;
	ezproxy_hosts: string[];
	alma: { base: string; inst: string } | null;
	libkey_library_id: number | null;
	idp_hosts: string[];
	entra_tenant: string | null;
	passthrough_hosts: string[];
	warmup_url: string;
	saml_entity_id: string | null;
	ezproxy_all_hosts: boolean;
}

const GENERIC_IDP_HOSTS = ["login.openathens.net", "login.microsoftonline.com", "login.live.com"];
const PASSTHROUGH_HOSTS = ["journals.lww.com"];
/** Warm-up destination: a subscription site whose OpenAthens / WAYFless chain reaches the IdP. */
export const WARM_TARGET = "https://www.nature.com/";

/** KCL's EZproxy host list (zotero-fulltext research/04 section 2.4). */
const KCL_EZPROXY_HOSTS = [
	"doi.org",
	"dx.doi.org",
	"www.bmj.com",
	"www.webofscience.com",
	"www.liebertpub.com",
	"www.jneurosci.org",
	"www.psychiatryonline.org",
	"psychiatryonline.org",
	"www.atsjournals.org",
	"www.ajronline.org",
	"www.jospt.org",
	"www.jove.com",
	"www.elgaronline.com",
	"infoweb.newsbank.com",
	"global.factiva.com",
	"www.portal.euromonitor.com",
	"institutions.newscientist.com",
	"www.lrb.co.uk",
	"libguides.kcl.ac.uk",
];

const KCL_ENGINE: EngineInstitution = {
	name: "King's College London",
	openathens_domain: "kcl.ac.uk",
	ezproxy: { login_host: "login.kcl.idm.oclc.org", suffix: "kcl.idm.oclc.org" },
	ezproxy_hosts: KCL_EZPROXY_HOSTS,
	alma: { base: "https://librarysearch.kcl.ac.uk", inst: "44KCL_INST" },
	libkey_library_id: 286,
	idp_hosts: ["login.microsoftonline.com", "login.live.com", "login.openathens.net", "kclidp.kcl.ac.uk"],
	entra_tenant: "8370cf14-16f3-4c16-b83c-724071654356",
	passthrough_hosts: PASSTHROUGH_HOSTS,
	warmup_url: "",
	saml_entity_id: "https://kclidp.kcl.ac.uk/idp/shibboleth",
	ezproxy_all_hosts: false,
};

// ---------------------------------------------------------------- presets (ported from the plugin)

function proxy(loginHost: string): string {
	return `https://${loginHost}/login?url=`;
}

function preset(id: string, name: string, o: { oa?: string; saml?: string; proxyHost?: string } = {}): InstitutionPreset {
	const methods: SignInMethod[] = [];
	if (o.oa) methods.push("openathens");
	if (o.saml) methods.push("saml");
	if (o.proxyHost) methods.push("ezproxy");
	return {
		id,
		name,
		methods,
		openathensDomain: o.oa,
		shibbolethEntityId: o.saml,
		proxyPrefix: o.proxyHost ? proxy(o.proxyHost) : undefined,
	};
}

export const PRESETS: InstitutionPreset[] = [
	preset("kcl", "King's College London", {
		oa: "kcl.ac.uk",
		saml: "https://kclidp.kcl.ac.uk/idp/shibboleth",
		proxyHost: "login.kcl.idm.oclc.org",
	}),
	preset("bath", "University of Bath", { saml: "https://idp.bath.ac.uk/shibboleth" }),
	preset("birmingham", "University of Birmingham", { saml: "https://idp.bham.ac.uk/shibboleth" }),
	preset("bristol", "University of Bristol", { saml: "https://idp.bris.ac.uk/shibboleth" }),
	preset("cambridge", "University of Cambridge", { saml: "https://shib.raven.cam.ac.uk/shibboleth" }),
	preset("cardiff", "Cardiff University", { saml: "https://idp.cardiff.ac.uk/shibboleth" }),
	preset("city", "City St George's, University of London", { oa: "city.ac.uk" }),
	preset("edinburgh", "University of Edinburgh", { saml: "https://idp.ed.ac.uk/shibboleth", proxyHost: "login.eux.idm.oclc.org" }),
	preset("exeter", "University of Exeter", { saml: "https://elibrary.exeter.ac.uk/idp/shibboleth" }),
	preset("glasgow", "University of Glasgow", { saml: "https://idp.gla.ac.uk/shibboleth", proxyHost: "login.uofglasgow.idm.oclc.org" }),
	preset("imperial", "Imperial College London", { saml: "https://shibboleth.imperial.ac.uk/shibboleth" }),
	preset("lancaster", "Lancaster University", { saml: "https://idp.lancs.ac.uk/idp/shibboleth" }),
	preset("leeds", "University of Leeds", { oa: "leeds.ac.uk", saml: "https://passport01.leeds.ac.uk/idp/shibboleth" }),
	preset("leicester", "University of Leicester", { saml: "https://idp.le.ac.uk/shibboleth" }),
	preset("lse", "London School of Economics and Political Science", { saml: "https://lse.ac.uk/idp" }),
	preset("manchester", "University of Manchester", { saml: "https://shib.manchester.ac.uk/shibboleth" }),
	preset("newcastle", "Newcastle University", { saml: "https://gateway.ncl.ac.uk/idp/shibboleth" }),
	preset("nottingham", "University of Nottingham", { saml: "https://idp.nottingham.ac.uk/shibboleth" }),
	preset("oxford", "University of Oxford", { saml: "https://registry.shibboleth.ox.ac.uk/idp" }),
	preset("qmul", "Queen Mary University of London", { saml: "https://idp.shibboleth.qmul.ac.uk/idp/shibboleth" }),
	preset("qub", "Queen's University Belfast", { saml: "https://qub.ac.uk/shibboleth", proxyHost: "qub.idm.oclc.org" }),
	preset("reading", "University of Reading", { oa: "reading.ac.uk" }),
	preset("sgul", "St George's, University of London", { oa: "sgul.ac.uk" }),
	preset("sheffield", "University of Sheffield", { saml: "https://idp.shef.ac.uk/shibboleth" }),
	preset("southampton", "University of Southampton", { saml: "https://webauth.soton.ac.uk/shibboleth", proxyHost: "soton.idm.oclc.org" }),
	preset("standrews", "University of St Andrews", { saml: "https://idp.st-andrews.ac.uk/shibboleth" }),
	preset("sussex", "University of Sussex", { saml: "https://idp.sussex.ac.uk/shibboleth" }),
	preset("ucl", "University College London", { oa: "ucl.ac.uk", saml: "https://shib-idp.ucl.ac.uk/shibboleth" }),
	preset("uea", "University of East Anglia", { oa: "uea.ac.uk", saml: "https://login.uea.ac.uk/entity" }),
	preset("warwick", "University of Warwick", { oa: "warwick.ac.uk", saml: "https://idp.warwick.ac.uk/idp/shibboleth" }),
	preset("york", "University of York", { saml: "https://shib.york.ac.uk/shibboleth" }),
];

export const DEFAULT_INSTITUTION_ID = "kcl";

export function findPreset(id: string | undefined): InstitutionPreset | null {
	return PRESETS.find((p) => p.id === id) ?? null;
}

export function searchPresets(q: string): InstitutionPreset[] {
	const words = q.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return PRESETS;
	return PRESETS.filter((p) => {
		const hay = `${p.name} ${p.id} ${p.openathensDomain ?? ""}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

// ---------------------------------------------------------------- parsing helpers (ported from config.js)

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normHost(s: string): string {
	return String(s)
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/\.+$/, "");
}

export function isEntityId(s: unknown): boolean {
	return (
		typeof s === "string" &&
		s.length > 0 &&
		s.length <= 1024 &&
		!/[\s\u0000-\u001f\u007f]/.test(s) &&
		/^(?:https?:\/\/[^/]+|urn:\S+)/i.test(s)
	);
}

function entityIdHost(entityId: string): string {
	const m = /^https?:\/\/([^/?#:@\s]+)/i.exec(entityId);
	return m ? m[1].toLowerCase() : "";
}

/** Accepts "login.x.idm.oclc.org", "https://login.x.idm.oclc.org/login?url=" and similar. */
export function parseProxyPrefix(
	raw: unknown,
): { ok: true; loginHost: string; suffix: string; prefix: string } | { ok: false; error: string } {
	const text = String(raw ?? "").trim();
	if (!text) return { ok: false, error: "the library proxy address is empty" };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(withScheme);
	if (!m || !/^https?$/i.test(m[1])) return { ok: false, error: "the library proxy address must be an http(s) address" };
	if (m[2].includes("@")) return { ok: false, error: "the library proxy address must not contain credentials" };
	if (/:\d*$/.test(m[2])) return { ok: false, error: "the library proxy address must not contain a port" };
	const host = normHost(m[2]);
	if (!HOSTNAME_RE.test(host) || !host.includes(".")) return { ok: false, error: "the library proxy address is not a valid host name" };
	const path = m[3].replace(/\/+$/, "").toLowerCase();
	if (path !== "" && path !== "/login")
		return { ok: false, error: "the library proxy address must be the login address (host or host/login)" };
	const suffix = /^login\..+\..+/.test(host) ? host.slice("login.".length) : host;
	return { ok: true, loginHost: host, suffix, prefix: proxy(host) };
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);

/** Validate and normalise what the user typed. Throws Error with a message fit for the UI. */
export function normalizeInstitution(input: unknown): InstitutionSettings {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("institution must be an object");
	const o = input as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const id = str(o.id);
	if (id && !/^[a-z0-9_-]{1,40}$/.test(id)) throw new Error("institution id is not valid");
	const base = findPreset(id);
	const name = str(o.name) || base?.name || "";
	if (id !== "none" && !name) throw new Error("institution name is required");
	if (name.length > 200) throw new Error("institution name is too long");
	const out: InstitutionSettings = { name };
	if (id) out.id = id;
	const domain = o.openathensDomain === undefined ? undefined : normHost(str(o.openathensDomain));
	if (domain) {
		if (!HOSTNAME_RE.test(domain)) throw new Error("the OpenAthens domain is not a valid domain name (for example kcl.ac.uk)");
		out.openathensDomain = domain;
	} else if (domain === "") out.openathensDomain = "";
	if (o.shibbolethEntityId !== undefined) {
		const e = str(o.shibbolethEntityId);
		if (e && !isEntityId(e)) throw new Error("the Shibboleth entityID must be an https:// address or a urn:");
		out.shibbolethEntityId = e;
	}
	if (o.proxyPrefix !== undefined) {
		const raw = str(o.proxyPrefix);
		if (raw) {
			const p = parseProxyPrefix(raw);
			if (!p.ok) throw new Error(p.error);
			out.proxyPrefix = p.prefix;
		} else out.proxyPrefix = "";
	}
	if (o.loginMode !== undefined && o.loginMode !== null && o.loginMode !== "") {
		if (o.loginMode !== "window" && o.loginMode !== "handoff") throw new Error('loginMode must be "window" or "handoff"');
		out.loginMode = o.loginMode;
	}
	const realm = str(o.realm);
	out.realm = realm ? slug(realm) : slug(id && id !== "other" ? id : name) || "institution";
	return out;
}

// ---------------------------------------------------------------- resolution

export interface ResolvedInstitution {
	id: string;
	name: string;
	realm: string;
	enabled: boolean; // false for "none"
	methods: SignInMethod[];
	openathensDomain: string;
	shibbolethEntityId: string;
	proxyPrefix: string;
	loginMode?: LoginMode;
	engine: EngineInstitution;
}

function proxyOf(prefix: string | undefined): { login_host: string; suffix: string } | null {
	if (!prefix) return null;
	const p = parseProxyPrefix(prefix);
	return p.ok ? { login_host: p.loginHost, suffix: p.suffix } : null;
}

/** The institution settings become the engine's institution block. Absent settings = the engine default (KCL). */
export function resolveInstitution(s: InstitutionSettings | undefined): ResolvedInstitution {
	if (!s) return describe(DEFAULT_INSTITUTION_ID, "kcl", true, undefined, KCL_ENGINE);
	const id = s.id || findPreset(slug(s.name))?.id || "other";
	if (id === "none") {
		const e = blankEngine(s.name || "No institution", "", "", null);
		return describe("none", "none", false, s.loginMode, e);
	}
	const base = findPreset(id);
	const pick = (v: string | undefined, d: string | undefined) => (v === undefined ? (d ?? "") : v);
	const domain = pick(s.openathensDomain, base?.openathensDomain);
	const saml = pick(s.shibbolethEntityId, base?.shibbolethEntityId);
	const prefix = pick(s.proxyPrefix, base?.proxyPrefix);
	let engine: EngineInstitution;
	if (id === "kcl") {
		engine = {
			...KCL_ENGINE,
			name: s.name || KCL_ENGINE.name,
			openathens_domain: domain,
			saml_entity_id: saml || null,
			ezproxy: proxyOf(prefix),
		};
		const hosts = new Set(engine.idp_hosts);
		const sh = saml ? entityIdHost(saml) : "";
		if (sh) hosts.add(sh);
		engine.idp_hosts = Array.from(hosts);
	} else {
		engine = blankEngine(s.name || base?.name || "", domain, saml, proxyOf(prefix));
		// a hand-written proxy has no host list: send every publisher through it
		engine.ezproxy_all_hosts = !!engine.ezproxy;
	}
	return describe(id, s.realm || slug(id === "other" ? s.name : id) || "institution", true, s.loginMode, engine);
}

function blankEngine(name: string, domain: string, saml: string, ez: { login_host: string; suffix: string } | null): EngineInstitution {
	const idp = [...GENERIC_IDP_HOSTS];
	const sh = saml ? entityIdHost(saml) : "";
	if (sh && !idp.includes(sh)) idp.push(sh);
	return {
		name,
		openathens_domain: domain,
		ezproxy: ez,
		ezproxy_hosts: [],
		alma: null,
		libkey_library_id: null,
		idp_hosts: idp,
		entra_tenant: null,
		passthrough_hosts: PASSTHROUGH_HOSTS,
		warmup_url: "",
		saml_entity_id: saml || null,
		ezproxy_all_hosts: false,
	};
}

function describe(
	id: string,
	realm: string,
	enabled: boolean,
	loginMode: LoginMode | undefined,
	engine: EngineInstitution,
): ResolvedInstitution {
	const methods: SignInMethod[] = [];
	if (engine.openathens_domain) methods.push("openathens");
	if (engine.saml_entity_id) methods.push("saml");
	if (engine.ezproxy) methods.push("ezproxy");
	return {
		id,
		name: engine.name,
		realm,
		enabled,
		methods,
		openathensDomain: engine.openathens_domain,
		shibbolethEntityId: engine.saml_entity_id ?? "",
		proxyPrefix: engine.ezproxy ? proxy(engine.ezproxy.login_host) : "",
		loginMode,
		engine,
	};
}

// ---------------------------------------------------------------- warm-up (login-controller.js warmUp)

/** Where the "Sign in to <institution>" window starts. null = the institution has no access method set up. */
export function warmupTarget(inst: EngineInstitution): { url: string; realm: string } | null {
	const custom = String(inst.warmup_url || "").trim();
	if (custom) return /^https?:\/\//i.test(custom) ? { url: custom, realm: "openathens" } : null;
	const domain = String(inst.openathens_domain || "").trim();
	if (domain) {
		return {
			url: `https://go.openathens.net/redirector/${encodeURIComponent(domain)}?url=${encodeURIComponent(WARM_TARGET)}`,
			realm: "openathens",
		};
	}
	if (inst.ezproxy?.login_host)
		return { url: `https://${inst.ezproxy.login_host}/login?url=${encodeURIComponent(WARM_TARGET)}`, realm: "ezproxy" };
	if (inst.saml_entity_id) {
		return {
			url: `https://sp.nature.com/saml/login?idp=${encodeURIComponent(inst.saml_entity_id)}&targetUrl=${encodeURIComponent(WARM_TARGET)}`,
			realm: "saml",
		};
	}
	return null;
}

/** Hosts whose cookies show an institutional sign-in exists (OpenAthens, the proxy, the IdP's own host; not Microsoft's). */
export function sessionHosts(inst: EngineInstitution): string[] {
	const out = new Set<string>(["login.openathens.net", "go.openathens.net"]);
	if (inst.ezproxy?.login_host) out.add(inst.ezproxy.login_host);
	const h = inst.saml_entity_id ? entityIdHost(inst.saml_entity_id) : "";
	if (h) out.add(h);
	return Array.from(out);
}

// ---------------------------------------------------------------- remote search (SeamlessAccess, as the plugin's picker)

export interface FederationHit {
	name: string;
	shibbolethEntityId: string;
	domain: string;
	ukFederation: boolean;
}

const UK_FEDERATION = "http://ukfederation.org.uk";

/** Port of config.js parseSamlSearch: visible IdPs of md.seamlessaccess.org's JSON, UK federation first, at most 30. */
export function parseFederationSearch(json: unknown): FederationHit[] {
	if (!Array.isArray(json)) return [];
	const seen = new Set<string>();
	const out: FederationHit[] = [];
	for (const e of json as Record<string, any>[]) {
		if (!e || typeof e !== "object") continue;
		if (e.type !== undefined && e.type !== "idp") continue;
		if (e.hidden === true || e.hidden === "true") continue;
		const cats: unknown[] = Array.isArray(e.entity_category) ? e.entity_category : [];
		if (cats.some((x) => /hide-from-discovery/.test(String(x)))) continue;
		const entityID = typeof e.entityID === "string" ? e.entityID : typeof e.entity_id === "string" ? e.entity_id : "";
		if (!isEntityId(entityID) || seen.has(entityID)) continue;
		seen.add(entityID);
		const en = e.title_langs && typeof e.title_langs.en === "string" ? e.title_langs.en : "";
		const title = String(typeof e.title === "string" && e.title.trim() ? e.title : en).trim() || entityID;
		const domain = String(e.domain || e.scope || "")
			.split(",")[0]
			.trim();
		const auth: unknown[] = Array.isArray(e.registrationAuthority) ? e.registrationAuthority : [];
		out.push({ name: title, shibbolethEntityId: entityID, domain, ukFederation: auth.includes(UK_FEDERATION) });
	}
	return out
		.filter((x) => x.ukFederation)
		.concat(out.filter((x) => !x.ukFederation))
		.slice(0, 30);
}
