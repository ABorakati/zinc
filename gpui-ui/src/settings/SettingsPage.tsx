// The Settings tab (ui/src/settings/SettingsPage.tsx): a section list on the left, a search box and the section's settings on the
// right. Sections come from the shell registry (registerSettingsSection): the built-in ones (defs/*.tsx, drawn from SettingDefs by
// SectionBody) and any a feature registered with its own render(). One section is shown at a time; while searching, every section
// with a match is stacked, with a count badge in the list.
import { createEffect, createMemo, For, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { settingsSections } from "../registry";
import { Divider, Txt, t, tok } from "../shell/kit";
import { persisted, isStr } from "../shell/prefs";
import { addKeyHandler } from "../shell/shortcuts";
import { Button, TextInput } from "../ui";
import { SettingRow } from "./controls";
import { queryTokens, sectionCount, sectionDef, sectionRows, setSettingsQuery, settingsQuery, settingsShown } from "./registry";

const [currentSection, setCurrentSection] = persisted<string>("shell.settings.section", "appearance", isStr);
/** Show a section of the Settings tab (clears the search); for links into Settings and for screenshots. */
export function gotoSection(id: string): void {
	setSettingsQuery("");
	setCurrentSection(id);
}

/** The rows of one built-in section (SettingDefs) under their group headings, filtered by the search. */
export function SectionBody(p: { id: string }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col"), width: "100%" }}>
			<For each={sectionRows(p.id)}>
				{(g) => (
					<>
						<Show when={g.name}>
							<div style={t("pt-3 pb-1")}>
								<Txt cls="text-[11px] font-semibold text-muted-foreground tracking-wide">{g.name!.toUpperCase()}</Txt>
							</div>
							<Divider />
						</Show>
						<For each={g.rows}>
							{(s, i) => (
								<SettingRow
									id={s.id}
									label={s.label}
									description={s.description}
									layout={s.layout}
									unavailable={s.unavailable ? s.unavailable : !s.control}
									control={s.control}
									last={i() === g.rows.length - 1}
								/>
							)}
						</For>
					</>
				)}
			</For>
		</div>
	);
}

function NavItem(p: { id: string; label: string; icon?: string; active: boolean; count?: number; onClick: () => void }): JSX.Element {
	const dim = () => p.count === 0;
	return (
		<div
			onClick={() => !dim() && p.onClick()}
			aria-label={p.label}
			style={{
				...t("flex items-center gap-2 rounded-md px-2 py-1.5"),
				cursor: dim() ? "default" : "pointer",
				opacity: dim() ? 0.4 : 1,
				...(p.active ? t("bg-accent") : {}),
				hover: dim() || p.active ? undefined : t("bg-accent/60"),
			}}
		>
			<Show when={p.icon}>
				<Icon name={p.icon!} size={16} color={tok(p.active ? "foreground" : "muted-foreground")} />
			</Show>
			<div style={{ minWidth: 0, flexGrow: 1, flexShrink: 1 }}>
				<Txt cls={`text-sm ${p.active ? "font-medium text-foreground" : "text-muted-foreground"} truncate`}>{p.label}</Txt>
			</div>
			<Show when={p.count !== undefined && p.count > 0}>
				<div style={t("flex items-center rounded-full bg-primary/15 px-1.5")}>
					<Txt cls="text-[10px] text-primary" wrap={false}>
						{String(p.count)}
					</Txt>
				</div>
			</Show>
		</div>
	);
}

export function SettingsPage(p: { active: boolean }): JSX.Element {
	const tokens = createMemo(() => queryTokens(settingsQuery()));
	const searching = () => tokens().length > 0;
	const sections = () => settingsSections();
	/** matches in a section: built-in ones count their rows; a feature's own section matches by its label */
	const countOf = (id: string, label: string): number =>
		sectionDef(id) ? sectionCount(id) : tokens().every((w) => label.toLowerCase().includes(w)) ? 1 : 0;
	const shown = createMemo(() => {
		const list = sections();
		if (searching()) return list.filter((s) => countOf(s.id, s.label) > 0);
		const cur = list.find((s) => s.id === currentSection()) ?? list[0];
		return cur ? [cur] : [];
	});
	const total = createMemo(() => sections().reduce((n, s) => n + (sectionDef(s.id) ? sectionCount(s.id) : 0), 0));
	const shownIds = createMemo(() => shown().map((s) => s.id), [], {
		equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
	});

	// Refresh only the visible section(s), and defer until after the Settings frame paints (plus a short debounce while searching
	// so intermediate single-letter matches do not trigger heavy refreshes for sections the user is only typing past).
	createEffect(() => {
		if (!p.active) return;
		const ids = shownIds();
		const delay = searching() ? 150 : 0;
		const timer = setTimeout(() => settingsShown(ids), delay);
		onCleanup(() => clearTimeout(timer));
	});
	// Escape clears the search while the tab is showing
	createEffect(() => {
		if (!p.active) return;
		const off = addKeyHandler((e) => {
			if (e.key === "escape" && settingsQuery()) {
				setSettingsQuery("");
				return true;
			}
			return false;
		});
		onCleanup(off);
	});

	return (
		<div style={{ ...t("flex bg-background"), width: "100%", height: "100%", minWidth: 0 }} aria-label="Settings">
			<div
				style={{
					...t("flex flex-col gap-0.5 border-r bg-card p-2"),
					width: 208,
					flexShrink: 0,
					height: "100%",
					overflowY: "scroll",
					scrollbarColor: tok("border"),
				}}
			>
				<div style={t("px-2 pt-1 pb-1.5")}>
					<Txt cls="text-xs font-semibold text-muted-foreground tracking-wide">SETTINGS</Txt>
				</div>
				<For each={sections()}>
					{(s) => (
						<NavItem
							id={s.id}
							label={s.label}
							icon={s.icon}
							active={!searching() && currentSection() === s.id}
							count={searching() ? countOf(s.id, s.label) : undefined}
							onClick={() => {
								setSettingsQuery("");
								setCurrentSection(s.id);
							}}
						/>
					)}
				</For>
			</div>

			<div style={{ ...t("flex flex-col"), flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%" }}>
				<div style={t("flex flex-none items-center gap-2 border-b px-6 py-2.5")}>
					<div style={{ ...t("flex items-center gap-2"), maxWidth: 560, flexGrow: 1 }}>
						<Icon name="search" size={14} color={tok("muted-foreground")} />
						<div style={{ flexGrow: 1, minWidth: 0 }}>
							<TextInput
								value={settingsQuery()}
								onInput={setSettingsQuery}
								placeholder="Search settings"
								autofocus={p.active}
							/>
						</div>
						<Show when={settingsQuery()}>
							<Button variant="ghost" size="icon" icon="x" onClick={() => setSettingsQuery("")}>
								{""}
							</Button>
						</Show>
					</div>
					<Show when={searching()}>
						<Txt cls="text-xs text-muted-foreground" wrap={false}>{`${total()} ${total() === 1 ? "setting" : "settings"}`}</Txt>
					</Show>
				</div>

				<div style={{ ...t("px-6 pb-24"), flexGrow: 1, minHeight: 0, overflowY: "scroll", scrollbarColor: tok("border") }}>
					<div style={{ ...t("flex flex-col"), maxWidth: 768, width: "100%", alignSelf: "center" }}>
						<For each={shown()}>
							{(s) => {
								const def = () => sectionDef(s.id);
								return (
									<div style={t("flex flex-col pt-6")}>
										<Txt cls="text-base font-semibold text-foreground">{s.label}</Txt>
										<Show when={def()?.description}>
											<Txt cls="text-xs text-muted-foreground mt-0.5">{def()!.description!}</Txt>
										</Show>
										<div style={{ ...t("mt-2 flex flex-col rounded-lg border bg-card px-4"), width: "100%" }}>
											{s.render()}
										</div>
									</div>
								);
							}}
						</For>
						<Show when={shown().length === 0}>
							<div style={t("flex flex-col items-center gap-3 py-24")}>
								<Icon name="search" size={32} color={tok("muted-foreground")} style={{ opacity: 0.5 }} />
								<Txt cls="text-sm text-foreground">{`No settings match "${settingsQuery().trim()}"`}</Txt>
								<Button variant="outline" size="sm" onClick={() => setSettingsQuery("")}>
									Clear search
								</Button>
							</div>
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
}
