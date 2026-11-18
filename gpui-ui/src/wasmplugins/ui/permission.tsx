// The run-time permission prompt (`permissions.request`): the package area calls this through `createPluginRuntime({ prompt })`.
// It is a modal dialog with the plugin's reason and the risk tier; true when the user allows it.
import { openDialog } from "../../ui";
import { Button } from "../../ui";
import { t, tok, tx } from "../../ui/core";
import { Icon } from "../../icons";

/** What the package area passes (plugin-host/src/permissions/service.ts `PermissionPromptRequest`). */
export interface PermissionPromptRequest {
	pluginId: string;
	pluginName: string;
	permission: string;
	tier: "low" | "medium" | "high" | string;
	/** The plugin's reason, already resolved to text. */
	reason: string;
	[k: string]: unknown;
}

const TIER_LABEL: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const TIER_ICON: Record<string, string> = { low: "shield-check", medium: "shield", high: "shield-alert" };

/** Ask the user whether `pluginName` may use `permission`. Escape or the X counts as "no". */
export async function promptPermission(req: PermissionPromptRequest): Promise<boolean> {
	const answer = await openDialog<boolean>(
		(close) => (
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
					<Icon name={TIER_ICON[req.tier] ?? "shield"} size={16} color={tok(req.tier === "high" ? "destructive" : "muted-foreground")} />
					<text style={{ ...tx("text-xs font-semibold"), color: tok(req.tier === "high" ? "destructive" : "muted-foreground") }}>{TIER_LABEL[req.tier] ?? String(req.tier)}</text>
				</div>
				<text style={tx("text-[13px] text-foreground")}>{`${req.pluginName} asks for the permission "${req.permission}".`}</text>
				<Show reason={req.reason} />
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
					<Button variant="outline" onClick={() => close(false)}>
						Don't allow
					</Button>
					<Button variant="primary" onClick={() => close(true)}>
						Allow
					</Button>
				</div>
			</div>
		),
		{ title: "Allow this plugin to do more?", width: 460 },
	);
	return answer === true;
}

function Show(p: { reason: string }) {
	return p.reason ? (
		<div style={{ ...t("rounded-md border bg-muted p-2.5") }}>
			<text style={tx("text-[13px] text-foreground")}>{p.reason}</text>
		</div>
	) : (
		(undefined as never)
	);
}
