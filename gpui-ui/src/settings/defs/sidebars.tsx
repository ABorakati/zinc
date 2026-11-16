// Settings > Appearance > Sidebars: what the left sidebar and the item pane show, and in which order (shell/sidebarLayout.ts).
// Each row has a switch (shown / hidden) and up / down buttons, as the Locate engines list (locate/settings.tsx).
// Registered after defs/appearance (settings/index.ts), so the rows sit at the end of that page.
import { For, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Txt, t, tok } from "../../shell/kit";
import { leftLayout, move, rightLayout, setShown } from "../../shell/sidebarLayout";
import { Button, Switch } from "../../ui";
import { Btn } from "../controls";
import { registerSettings } from "../registry";

type Side = typeof leftLayout;

function LayoutList(p: { side: Side }): JSX.Element {
	const l = () => p.side.layout();
	const part = (id: string) => p.side.parts.find((x) => x.id === id)!;
	return (
		<div style={{ ...t("flex flex-col"), width: "100%", maxWidth: 420 }}>
			<For each={l().order}>
				{(id, i) => {
					const shown = () => !l().hidden.includes(id);
					const pinned = () => !!part(id).pinnedLast;
					// the part below a movable one may be pinned (Tags stays last)
					const canDown = () => i() < l().order.length - 1 && !pinned() && !part(l().order[i() + 1]!).pinnedLast;
					return (
						<div style={{ ...t("flex items-center gap-3 py-1"), width: "100%" }}>
							<Switch
								checked={shown()}
								aria-label={`Show ${part(id).label}`}
								onChange={(v) => p.side.set(setShown(l(), id, v))}
							/>
							<div style={{ ...t("flex items-center gap-2"), flexGrow: 1, minWidth: 0, opacity: shown() ? 1 : 0.55 }}>
								<Icon name={part(id).icon} size={14} color={tok("muted-foreground")} />
								<Txt cls="text-sm text-foreground" wrap={false}>
									{part(id).label + (pinned() ? " (always at the bottom)" : "")}
								</Txt>
							</div>
							<Button
								variant="ghost"
								size="icon"
								icon="chevron-up"
								aria-label={`Move ${part(id).label} up`}
								disabled={i() === 0 || pinned()}
								onClick={() => p.side.set(move(l(), id, -1, p.side.parts))}
							/>
							<Button
								variant="ghost"
								size="icon"
								icon="chevron-down"
								aria-label={`Move ${part(id).label} down`}
								disabled={!canDown()}
								onClick={() => p.side.set(move(l(), id, 1, p.side.parts))}
							/>
						</div>
					);
				}}
			</For>
		</div>
	);
}

registerSettings([
	{
		id: "appearance.sidebar-left",
		section: "appearance",
		group: "Sidebars",
		label: "Left sidebar",
		description: "Which groups the left sidebar shows, and in which order. At least one stays shown.",
		keywords: [
			"sidebar",
			"collections",
			"library",
			"saved searches",
			"group libraries",
			"tags",
			"order",
			"hide",
			"reorder",
			"customize",
		],
		layout: "block",
		control: () => <LayoutList side={leftLayout} />,
	},
	{
		id: "appearance.sidebar-right",
		section: "appearance",
		group: "Sidebars",
		label: "Item pane",
		description: "Which sections the item pane on the right shows, and in which order. The tabs under its header follow.",
		keywords: ["item pane", "details", "abstract", "notes", "files", "attachments", "related", "order", "hide", "reorder", "customize"],
		layout: "block",
		control: () => <LayoutList side={rightLayout} />,
	},
	{
		id: "appearance.sidebar-reset",
		section: "appearance",
		group: "Sidebars",
		label: "Reset sidebars",
		description: "Show every group and section again, in the default order.",
		keywords: ["default", "restore", "sidebar"],
		control: () => (
			<Btn
				onClick={() => {
					leftLayout.reset();
					rightLayout.reset();
				}}
			>
				Reset
			</Btn>
		),
	},
]);
