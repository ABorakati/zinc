// `condition` of extend.wit: a declarative rule over the current context that the host evaluates itself (no plugin call).
import type { Condition, RowKind, TabRef } from "./wit";

export interface CondCtx {
	tab: TabRef;
	itemCount: number;
	/** Item types of the selected items the host knows (the list cache); an item it does not know cannot fail `item-types`. */
	itemTypes: string[];
	rowKinds: RowKind[];
	editable: boolean;
}

function tabKindMatches(pattern: string, tab: TabRef): boolean {
	if (pattern === tab.kind) return true;
	const [kind, sub] = pattern.split("/");
	if (kind !== tab.kind) return false;
	return sub === "*" || sub === undefined || sub === (tab.subtype ?? undefined);
}

/** True when the condition holds (or there is none). Every set field must hold; empty lists and `none` mean "no rule". */
export function conditionHolds(c: Condition | null | undefined, x: CondCtx): boolean {
	if (!c) return true;
	if (c.tabKinds?.length && !c.tabKinds.some((p) => tabKindMatches(p, x.tab))) return false;
	if (c.minItems != null && x.itemCount < c.minItems) return false;
	if (c.maxItems != null && x.itemCount > c.maxItems) return false;
	if (c.itemTypes?.length && !x.itemTypes.every((t) => c.itemTypes!.includes(t))) return false;
	if (c.rowKinds?.length && !x.rowKinds.every((r) => c.rowKinds!.includes(r))) return false;
	if (c.requireEditable && !x.editable) return false;
	return true;
}
