// Find Full Text settings: the institution (searchable list of known institutions plus the access methods it
// offers), the sign-in mode and the Unpaywall email. Mounted by <FullTextProgress /> so it is reachable from the
// progress panel; openFullTextSettings() opens it from anywhere (menus, toasts).
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { toast } from "solid-sonner";
import type {
	FullTextInstitutionHit,
	FullTextSettingsPatch,
	FullTextSettingsView,
} from "../../../core/src/api-types";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { call } from "./jobs";
import { onOpenSettings, refreshSignInStatus } from "./signin";

const [open, setOpen] = createSignal(false);
export const openFullTextSettings = () => setOpen(true);

type LoginMode = "" | "window" | "handoff";

const METHOD_LABEL = { openathens: "OpenAthens", saml: "Shibboleth / UK federation", ezproxy: "Library proxy" } as const;

const Field: Component<{ label: string; hint?: string; children: any }> = (props) => (
	<label class="grid gap-1 text-xs">
		<span class="font-medium">{props.label}</span>
		{props.children}
		<Show when={props.hint}>
			<span class="text-muted-foreground">{props.hint}</span>
		</Show>
	</label>
);

export const FullTextSettingsDialog: Component = () => {
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
	// "Use default" sends institution: null (the engine default)
	const [useDefault, setUseDefault] = createSignal(false);

	onMount(() => onOpenSettings(openFullTextSettings));

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
		setUseDefault(false);
	};

	createEffect(() => {
		if (!open()) return;
		setError("");
		setQuery("");
		call<FullTextSettingsView>("GET", "/settings")
			.then(fill)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	});

	// search as you type (federation lookups only start at 3 characters; the server decides)
	createEffect(() => {
		const q = query();
		if (!open()) return;
		setSearching(true);
		const t = setTimeout(async () => {
			try {
				setHits(await call<FullTextInstitutionHit[]>("GET", `/institutions?q=${encodeURIComponent(q)}`));
			} catch {
				setHits([]);
			} finally {
				setSearching(false);
			}
		}, 250);
		onCleanup(() => clearTimeout(t));
	});

	const choose = (h: FullTextInstitutionHit) => {
		setId(h.id ?? "other");
		setName(h.name);
		setDomain(h.openathensDomain ?? "");
		setEntity(h.shibbolethEntityId ?? "");
		setProxy(h.proxyPrefix ?? "");
		setUseDefault(false);
		setInstitutional(true);
	};

	const methods = () => {
		const m: (keyof typeof METHOD_LABEL)[] = [];
		if (domain().trim()) m.push("openathens");
		if (entity().trim()) m.push("saml");
		if (proxy().trim()) m.push("ezproxy");
		return m;
	};

	const save = async () => {
		setSaving(true);
		setError("");
		try {
			const patch: FullTextSettingsPatch = {
				institutional: institutional(),
				unpaywallEmail: email().trim(),
				institution: useDefault()
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
			toast.success("Find Full Text settings saved", { description: `Institution: ${v.institution.name}` });
			void refreshSignInStatus();
			setOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open()} onOpenChange={setOpen}>
			<DialogContent class="max-w-xl gap-3">
				<DialogHeader>
					<DialogTitle>Find Full Text settings</DialogTitle>
					<DialogDescription>
						Choose the institution whose subscriptions Find Full Text may use. Open access sources are always tried first.
					</DialogDescription>
				</DialogHeader>

				<section class="grid gap-2">
					<Field label="Find your institution">
						<Input placeholder="Search by name, e.g. “University of Leeds”" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
					</Field>
					<ul class="max-h-36 overflow-y-auto rounded-md border border-border text-xs" aria-label="Institutions">
						<For each={hits()} fallback={<li class="px-2 py-1.5 text-muted-foreground">{searching() ? "Searching…" : "No institution found. Fill in the details below."}</li>}>
							{(h) => (
								<li>
									<button type="button" class="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent" onClick={() => choose(h)}>
										<span class="min-w-0 flex-1 truncate">{h.name}</span>
										<span class="shrink-0 text-muted-foreground">
											{h.methods.map((m) => METHOD_LABEL[m]).join(" · ") || "no methods known"}
										</span>
									</button>
								</li>
							)}
						</For>
					</ul>
				</section>

				<section class="grid gap-2 sm:grid-cols-2">
					<Field label="Institution name">
						<Input
							value={name()}
							onInput={(e) => {
								setName(e.currentTarget.value);
								setUseDefault(false);
							}}
						/>
					</Field>
					<Field label="OpenAthens domain" hint="e.g. ucl.ac.uk">
						<Input value={domain()} onInput={(e) => setDomain(e.currentTarget.value)} />
					</Field>
					<Field label="Shibboleth entityID" hint="UK federation identity provider">
						<Input value={entity()} onInput={(e) => setEntity(e.currentTarget.value)} />
					</Field>
					<Field label="Library proxy address" hint="e.g. https://login.example.idm.oclc.org">
						<Input value={proxy()} onInput={(e) => setProxy(e.currentTarget.value)} />
					</Field>
				</section>
				<p class="text-xs text-muted-foreground">
					Sign-in methods set up: {methods().length ? methods().map((m) => METHOD_LABEL[m]).join(", ") : "none yet. Add at least one to use institutional access."}
				</p>

				<section class="grid gap-2 sm:grid-cols-2">
					<Field
						label="How to sign in"
						hint={view()?.embeddedBrowser ? undefined : "This build has no sign-in window; links open in your own browser."}
					>
						<select
							class="h-7 rounded-md border border-input bg-transparent px-2 text-[13px]"
							value={mode()}
							onChange={(e) => setMode(e.currentTarget.value as LoginMode)}
						>
							<option value="">Automatic</option>
							<option value="window">In a window here</option>
							<option value="handoff">Link for my own browser</option>
						</select>
					</Field>
					<Field label="Unpaywall email" hint="Needed for Unpaywall; stays on your computer.">
						<Input type="email" placeholder="you@example.org" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
					</Field>
				</section>

				<label class="flex items-center gap-2 text-xs">
					<input type="checkbox" checked={institutional()} onChange={(e) => setInstitutional(e.currentTarget.checked)} />
					Use institutional access (off = open access only)
				</label>

				<Show when={error()}>
					<div class="text-xs text-destructive" role="alert">{error()}</div>
				</Show>

				<DialogFooter class="items-center gap-2 sm:justify-between">
					<Show when={view() && !view()!.isDefaultInstitution} fallback={<span />}>
						<Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onClick={() => {
								setUseDefault(true);
								void save();
							}} disabled={saving()}>
							Use the built-in default
						</Button>
					</Show>
					<div class="flex gap-2">
						<Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
						<Button size="sm" onClick={save} disabled={saving() || (!useDefault() && !name().trim() && institutional())}>
							{saving() ? "Saving" : "Save"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export default FullTextSettingsDialog;
