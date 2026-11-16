// Find Full Text settings: the institution (searchable list of known institutions plus the access methods it offers), the
// sign-in mode and the Unpaywall email, as a dialog (openFullTextSettings) and as the Settings > Find Full Text section.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Button, Checkbox, openDialog, Select, Switch, TextInput, toast } from "../../ui";
import { ErrorLine, Field, Footer, Line, Para, Row, Scroll, SettingRow, SettingsBody, t, Txt } from "../kit";
import { errMsg } from "../text";
import type { FullTextInstitutionHit, FullTextSettingsPatch, FullTextSettingsView } from "../types";
import { call } from "./jobs";
import { onOpenSettings, refreshSignInStatus } from "./signin";

type LoginMode = "" | "window" | "handoff";
const METHOD_LABEL = { openathens: "OpenAthens", saml: "Shibboleth / UK federation", ezproxy: "Library proxy" } as const;
const LOGIN_OPTS = [
	{ value: "" as LoginMode, label: "Automatic" },
	{ value: "window" as LoginMode, label: "In a window here" },
	{ value: "handoff" as LoginMode, label: "Link for my own browser" },
];

function SettingsDialog(p: { close: () => void }): JSX.Element {
	const [view, setView] = createSignal<FullTextSettingsView | null>(null);
	const [id, setId] = createSignal("other");
	const [name, setName] = createSignal("");
	const [domain, setDomain] = createSignal("");
	const [entity, setEntity] = createSignal("");
	const [proxy, setProxy] = createSignal("");
	const [mode, setMode] = createSignal<LoginMode>("");
	const [institutional, setInstitutional] = createSignal(true);
	const [email, setEmail] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [hits, setHits] = createSignal<FullTextInstitutionHit[]>([]);
	const [searching, setSearching] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal("");

	const fill = (v: FullTextSettingsView) => {
		setView(v);
		setId(v.institution.id);
		setName(v.institution.name);
		setDomain(v.institution.openathensDomain);
		setEntity(v.institution.shibbolethEntityId);
		setProxy(v.institution.proxyPrefix);
		setMode(v.institution.loginMode ?? "");
		setInstitutional(v.institutional);
		setEmail(v.unpaywallEmail);
	};
	onMount(() => void call<FullTextSettingsView>("GET", "/settings").then(fill, (e) => setError(errMsg(e))));

	// search as you type (federation lookups only start at 3 characters; the server decides)
	createEffect(
		on(query, (q) => {
			setSearching(true);
			const timer = setTimeout(async () => {
				try {
					setHits(await call<FullTextInstitutionHit[]>("GET", `/institutions?q=${encodeURIComponent(q)}`));
				} catch {
					setHits([]);
				} finally {
					setSearching(false);
				}
			}, 250);
			onCleanup(() => clearTimeout(timer));
		}),
	);

	const choose = (h: FullTextInstitutionHit) => {
		setId(h.id ?? "other");
		setName(h.name);
		setDomain(h.openathensDomain ?? "");
		setEntity(h.shibbolethEntityId ?? "");
		setProxy(h.proxyPrefix ?? "");
		setInstitutional(true);
	};
	const methods = () => {
		const m: (keyof typeof METHOD_LABEL)[] = [];
		if (domain().trim()) m.push("openathens");
		if (entity().trim()) m.push("saml");
		if (proxy().trim()) m.push("ezproxy");
		return m;
	};

	const save = async (useDefault: boolean) => {
		setSaving(true);
		setError("");
		try {
			const patch: FullTextSettingsPatch = {
				institutional: institutional(),
				unpaywallEmail: email().trim(),
				institution: useDefault
					? null
					: {
							id: id(),
							name: name().trim(),
							openathensDomain: domain().trim(),
							shibbolethEntityId: entity().trim(),
							proxyPrefix: proxy().trim(),
							...(mode() ? { loginMode: mode() as "window" | "handoff" } : {}),
						},
			};
			const v = await call<FullTextSettingsView>("PUT", "/settings", patch);
			fill(v);
			toast("Find Full Text settings saved", { kind: "success", description: `Institution: ${v.institution.name}` });
			void refreshSignInStatus();
			p.close();
		} catch (e) {
			setError(errMsg(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Para class="text-sm text-muted-foreground">
				Choose the institution whose subscriptions Find Full Text may use. Open access sources are always tried first.
			</Para>
			<Field label="Find your institution">
				<TextInput value={query()} onInput={setQuery} placeholder="Search by name, e.g. University of Leeds" />
			</Field>
			<Scroll border height={120}>
				<For
					each={hits()}
					fallback={
						<div style={t("px-2 py-1.5")}>
							<Txt class="text-xs text-muted-foreground">
								{searching() ? "Searching…" : "No institution found. Fill in the details below."}
							</Txt>
						</div>
					}
				>
					{(h) => (
						<Row onClick={() => choose(h)} style={{ flexShrink: 0 }}>
							<Line class="text-xs text-foreground" style={{ flexGrow: 1 }}>
								{h.name}
							</Line>
							<Line class="text-xs text-muted-foreground" style={{ flexShrink: 0 }}>
								{h.methods.map((m) => METHOD_LABEL[m]).join(" · ") || "no methods known"}
							</Line>
						</Row>
					)}
				</For>
			</Scroll>
			<div style={{ ...t("flex flex-row gap-3"), width: "100%" }}>
				<Field label="Institution name" style={{ flexGrow: 1, flexBasis: 0 }}>
					<TextInput value={name()} onInput={setName} />
				</Field>
				<Field label="OpenAthens domain" hint="e.g. ucl.ac.uk" style={{ flexGrow: 1, flexBasis: 0 }}>
					<TextInput value={domain()} onInput={setDomain} />
				</Field>
			</div>
			<div style={{ ...t("flex flex-row gap-3"), width: "100%" }}>
				<Field label="Shibboleth entityID" hint="UK federation identity provider" style={{ flexGrow: 1, flexBasis: 0 }}>
					<TextInput value={entity()} onInput={setEntity} />
				</Field>
				<Field label="Library proxy address" hint="e.g. https://login.example.idm.oclc.org" style={{ flexGrow: 1, flexBasis: 0 }}>
					<TextInput value={proxy()} onInput={setProxy} />
				</Field>
			</div>
			<Txt class="text-xs text-muted-foreground">{`Sign-in methods set up: ${
				methods().length
					? methods()
							.map((m) => METHOD_LABEL[m])
							.join(", ")
					: "none yet. Add at least one to use institutional access."
			}`}</Txt>
			<div style={{ ...t("flex flex-row gap-3"), width: "100%" }}>
				<Field
					label="How to sign in"
					hint={
						view() && !view()!.embeddedBrowser
							? "The sign-in window is not available on this system. Links open in your own browser."
							: undefined
					}
					style={{ flexGrow: 1, flexBasis: 0 }}
				>
					<Select value={mode()} onChange={setMode} options={LOGIN_OPTS} />
				</Field>
				<Field label="Unpaywall email" hint="Needed for Unpaywall; stays on your computer." style={{ flexGrow: 1, flexBasis: 0 }}>
					<TextInput value={email()} onInput={setEmail} placeholder="you@example.org" />
				</Field>
			</div>
			<Checkbox checked={institutional()} onChange={setInstitutional} label="Use institutional access (off = open access only)" />
			<ErrorLine>{error()}</ErrorLine>
			<Footer
				left={
					<Show when={view() && !view()!.isDefaultInstitution}>
						<Button variant="ghost" size="sm" disabled={saving()} onClick={() => void save(true)}>
							Use the built-in default
						</Button>
					</Show>
				}
			>
				<Button variant="outline" size="sm" onClick={p.close}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={saving() || (!name().trim() && institutional())}
					onClick={() => void save(false)}
				>
					{saving() ? "Saving" : "Save"}
				</Button>
			</Footer>
		</div>
	);
}

let dialogOpen = false;
export function openFullTextSettings(): void {
	if (dialogOpen) return;
	dialogOpen = true;
	void openDialog<void>((close) => <SettingsDialog close={() => close()} />, { title: "Find Full Text settings", width: 720 }).finally(
		() => {
			dialogOpen = false;
		},
	);
}
onOpenSettings(openFullTextSettings);

/** Settings > Find Full Text. */
export function FullTextSettingsSection(): JSX.Element {
	const [view, setView] = createSignal<FullTextSettingsView | null>(null);
	const [error, setError] = createSignal("");
	const reload = () =>
		call<FullTextSettingsView>("GET", "/settings").then(
			(v) => {
				setView(v);
				setError("");
			},
			(e) => setError(errMsg(e)),
		);
	const put = (patch: FullTextSettingsPatch) =>
		call<FullTextSettingsView>("PUT", "/settings", patch).then(setView, (e) =>
			toast("Could not save", { kind: "error", description: errMsg(e) }),
		);
	onMount(() => void reload());
	const [email, setEmail] = createSignal("");
	createEffect(on(view, (v) => v && setEmail(v.unpaywallEmail)));
	return (
		<SettingsBody>
			<Show when={view()} fallback={<Txt class="text-[13px] text-muted-foreground">{error() || "Loading…"}</Txt>}>
				{(v) => (
					<>
						<SettingRow label="Institution" description="The library whose subscriptions are used to find PDFs.">
							<Line
								class="text-[13px] text-foreground"
								style={{ maxWidth: 260 }}
							>{`${v().institution.name}${v().isDefaultInstitution ? " (default)" : ""}`}</Line>
							<Button variant="outline" size="sm" onClick={openFullTextSettings}>
								Change…
							</Button>
						</SettingRow>
						<SettingRow label="Use institutional access" description="Off: open-access sources only.">
							<Switch checked={v().institutional} onChange={(institutional) => void put({ institutional })} />
						</SettingRow>
						<SettingRow label="Unpaywall email" description="Sent to Unpaywall with each lookup, as their terms ask.">
							<div style={{ width: 240 }}>
								<TextInput
									value={email()}
									onInput={setEmail}
									onEnter={() => void put({ unpaywallEmail: email().trim() })}
									placeholder="you@example.org"
								/>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={email().trim() === v().unpaywallEmail}
								onClick={() => void put({ unpaywallEmail: email().trim() })}
							>
								Save
							</Button>
						</SettingRow>
						<SettingRow label="Items fetched at once" description="More is faster but harder on publisher sites.">
							<Select
								value={String(v().concurrency)}
								onChange={(n) => void put({ concurrency: +n })}
								width={90}
								options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
							/>
						</SettingRow>
					</>
				)}
			</Show>
		</SettingsBody>
	);
}
