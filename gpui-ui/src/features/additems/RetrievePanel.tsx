// "Retrieve Metadata" progress panel (bottom-left; Find Full Text uses bottom-right): one row per PDF and a summary
// ("Recognised 3, not found 1") once the queue is empty. Mounted through registerOverlay in register.tsx.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { FloatingPanel, Line, t, tok } from "../kit";
import { dismissRetrieve, retrieveActive, retrieveRows, type RetrieveRow } from "./client";

const [collapsed, setCollapsed] = createSignal(false);

const LABEL: Record<RetrieveRow["state"], string> = {
	queued: "Waiting",
	running: "Looking up",
	retrieved: "Parent item created",
	existing: "Attached to existing item",
	failed: "No match found",
};

function RowIcon(p: { state: RetrieveRow["state"] }): JSX.Element {
	const name = () => ({ retrieved: "check", existing: "link-2", failed: "circle-slash", running: "loader-circle", queued: "circle" })[p.state];
	const color = () => (p.state === "retrieved" || p.state === "existing" ? "#16a34a" : p.state === "running" ? tok("primary") : tok("muted-foreground"));
	return <Icon name={name()} size={16} color={color()} />;
}

export function RetrievePanel(): JSX.Element {
	const total = () => retrieveRows().length;
	const finished = () => retrieveRows().filter((r) => r.state !== "queued" && r.state !== "running").length;
	const found = () => retrieveRows().filter((r) => r.state === "retrieved" || r.state === "existing").length;
	const missed = () => retrieveRows().filter((r) => r.state === "failed").length;
	const subtitle = () => (retrieveActive() ? `${finished()} of ${total()}` : `Recognised ${found()}${missed() ? `, not found ${missed()}` : ""}`);
	return (
		<Show when={total() > 0}>
			<FloatingPanel
				side="left"
				title="Retrieve Metadata"
				subtitle={subtitle()}
				progress={retrieveActive() ? finished() / Math.max(1, total()) : undefined}
				collapsed={collapsed()}
				onToggle={() => setCollapsed(!collapsed())}
				onClose={retrieveActive() ? undefined : dismissRetrieve}
			>
				<For each={retrieveRows()}>
					{(r) => (
						<div style={{ ...t("flex flex-row items-start gap-2 px-3 py-1.5"), flexShrink: 0 }}>
							<div style={{ marginTop: 1 }}><RowIcon state={r.state} /></div>
							<div style={{ ...t("flex flex-col"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
								<Line class="text-xs text-foreground">{r.title}</Line>
								<Line class="text-xs text-muted-foreground">{r.state === "failed" && r.message ? `${LABEL.failed} · ${r.message}` : LABEL[r.state]}</Line>
							</div>
						</div>
					)}
				</For>
			</FloatingPanel>
		</Show>
	);
}
