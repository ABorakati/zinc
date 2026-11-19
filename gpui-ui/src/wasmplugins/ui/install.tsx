// The install prompt (`PluginManager` `approve`): what a plugin package asks for, grouped by risk, before anything of it runs.
// Low-risk permissions are ticked, medium ones ticked but each can be unticked, high ones unticked until the user ticks them
// (lifecycle.md 2.4). Optional permissions are listed, never granted here: the plugin asks for them when it needs them.
// Also used to approve the permissions an update added (`approvePending`).
import { createSignal, For, Show } from "solid-js";
import type { Approval, ApprovalRequest } from "../../../../plugin-host/src/package/installer";
import { Button, Checkbox, openDialog } from "../../ui";
import { t, tok, tx } from "../../ui/core";
import { Icon } from "../../icons";

const TIER_LABEL: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const TIER_ICON: Record<string, string> = { low: "shield-check", medium: "shield", high: "shield-alert" };
const ACTION_LABEL: Record<string, string> = { install: "Install", upgrade: "Update", downgrade: "Downgrade", reinstall: "Reinstall" };
const NET = "net.hosts:";

/** What the user reads for a permission id. */
export function permissionLabel(id: string): string {
	return id.startsWith(NET) ? `Connect to ${id.slice(NET.length)}` : id;
}

/** A manifest reason is plain text when it has a space; otherwise it is a Fluent id, which cannot be resolved before install. */
const reasonText = (r: string | undefined): string | undefined => (r && /\s/.test(r) ? r : undefined);

/** What the prompt ticks to begin with: the required low and medium permissions. High ones wait for the user; optional ones are never granted here. */
export function initialGrants(req: Pick<ApprovalRequest, "groups" | "required">): Set<string> {
	const required = new Set(req.required);
	const out = new Set<string>();
	for (const g of req.groups) for (const it of g.items) if (!it.optional && required.has(it.id) && g.tier !== "high") out.add(it.id);
	return out;
}

/** Ask the user to install (or update) a plugin. Resolves with the ids they allowed, or false when they cancel. */
export async function promptInstall(req: ApprovalRequest): Promise<Approval> {
	const m = req.manifest as unknown as { name: string; version: string; author?: unknown; description?: unknown };
	const [checked, setChecked] = createSignal(initialGrants(req));
	const toggle = (id: string, on: boolean) =>
		setChecked((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	const verb = ACTION_LABEL[req.action] ?? "Install";
	const any = req.groups.some((g) => g.items.length > 0);
	const answer = await openDialog<Approval>(
		(close) => (
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<text style={tx("text-[13px] font-semibold text-foreground")}>
					{(req.previousVersion ? `${m.name} ${req.previousVersion} → ${m.version}` : `${m.name} ${m.version}`) +
						(typeof m.author === "string" && m.author ? ` by ${m.author}` : "")}
				</text>
				<Show when={typeof m.description === "string" && m.description}>
					<text style={tx("text-[13px] text-muted-foreground")}>{String(m.description)}</text>
				</Show>
				<Show
					when={any}
					fallback={<text style={tx("text-[13px] text-muted-foreground")}>{req.previousVersion ? "It asks for no new permissions." : "It asks for no permissions."}</text>}
				>
					<text style={tx("text-[13px] text-foreground")}>{req.previousVersion ? "The new version asks for:" : "It asks for:"}</text>
					<For each={req.groups.filter((g) => g.items.length > 0)}>
						{(g) => (
							<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
								<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
									<Icon name={TIER_ICON[g.tier] ?? "shield"} size={14} color={tok(g.tier === "high" ? "destructive" : "muted-foreground")} />
									<text style={{ ...tx("text-xs font-semibold"), color: tok(g.tier === "high" ? "destructive" : "muted-foreground") }}>{TIER_LABEL[g.tier] ?? g.tier}</text>
								</div>
								<For each={g.items}>
									{(it) => (
										<div style={{ ...t("rounded-md border p-2"), display: "flex", flexDirection: "column", gap: 4 }}>
											<Show
												when={!it.optional}
												fallback={<text style={tx("text-[13px] text-foreground")}>{`${permissionLabel(it.id)} (asked for later, only if needed)`}</text>}
											>
												<Checkbox checked={checked().has(it.id)} onChange={(on) => toggle(it.id, on)} label={permissionLabel(it.id)} />
											</Show>
											<Show when={reasonText(it.reason)}>
												<text style={tx("text-xs text-muted-foreground")}>{reasonText(it.reason)}</text>
											</Show>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
					<text style={tx("text-xs text-muted-foreground")}>A permission you leave unticked is refused: the features that need it will not work.</text>
				</Show>
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
					<Button variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button variant="primary" onClick={() => close({ grant: [...checked()] })}>
						{verb}
					</Button>
				</div>
			</div>
		),
		{ title: `${verb} this plugin?`, width: 500 },
	);
	return answer ?? false;
}
