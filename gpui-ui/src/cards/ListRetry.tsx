// The notice over a populated list when some of its pages could not be loaded (their rows would stay grey skeletons): the
// reason and a Retry button that asks for those pages again (store.retryFailed). Used by the cards, the table and the search list.
import { Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { Button } from "../ui";

export function ListRetry(): JSX.Element {
	const m = () => store.mode();
	return (
		<Show when={store.failedPages() > 0 && store.total() > 0}>
			<div
				role="alert"
				style={{ ...tw("flex flex-row items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-raised", m()), position: "absolute", left: 12, right: 12, bottom: 12, borderColor: tokens[m()]["destructive"] }}
			>
				<Icon name="circle-alert" size={14} color={tokens[m()]["destructive"] ?? "#d33"} />
				<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
					<text style={textStyle("text-xs font-medium text-foreground", m())}>Some items could not be loaded</text>
					<Show when={store.error()}>
						<text style={{ ...textStyle("text-[11px] text-muted-foreground", m()), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{store.error() ?? ""}</text>
					</Show>
				</div>
				<Button size="sm" variant="outline" onClick={() => store.retryFailed()}>Retry</Button>
			</div>
		</Show>
	);
}
