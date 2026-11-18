// Example scenario for scripts/verify-port.ts (written for the Reading List port; see references/worked-example.md).
// bun scripts/verify-port.ts <plugin dir> --scenario scripts/scenario.example.ts
export default async (t: any) => {
	const reg = (iface: string, fn: string) => t.calls.filter((c: any) => c.iface === iface && c.fn === fn);
	t.check(reg("extend", "register-menu").length === 1, "registered one menu");
	t.check(reg("extend", "register-column").length === 1, "registered the column");
	t.check(reg("extend", "register-pref-pane").length === 1, "registered the pref pane");
	const list = await t.api("/api/items?limit=10");
	const key = (list.items ?? list.data ?? list)[0]?.key ?? (list.items ?? list)[0]?.data?.key;
	console.log("using item", key);
	const ctx = { window: 1, tab: { id: "library", kind: "library", subtype: undefined }, library: 1, rows: [], items: [key], itemCount: 1, itemsTruncated: false, editable: true, field: undefined };
	await t.sup.call(t.id, "extend-handlers", "on-menu-command", ["rl-menu", "rl.s3", undefined, ctx]);
	const stored = await t.api(`/api/items/${key}`);
	console.log("extra now:", JSON.stringify(stored.data.extra));
	t.check(/Read_Status: Read\b/.test(stored.data.extra ?? ""), "menu command wrote Read_Status into Extra");
	const cells: any = await t.sup.call(t.id, "extend-handlers", "on-column-values", ["rl-readstatus", [key]]);
	console.log("cells", JSON.stringify(cells));
	t.check(cells[0].body.val === "Read", "column shows Read");
	await t.sup.call(t.id, "extend-handlers", "on-menu-command", ["rl-menu", "rl.none", undefined, ctx]);
	const cleared = await t.api(`/api/items/${key}`);
	t.check(!/Read_Status/.test(cleared.data.extra ?? ""), "None clears the status");
	t.prefs.set("label-new-items", "To Read");
	const r = await t.api("/api/items", { method: "POST", json: { data: { itemType: "book", title: "New book from the user" } } });
	const nk = r.data.key;
	const t0 = Date.now(); let ok = false;
	while (Date.now() - t0 < 8000) { const g = await t.api(`/api/items/${nk}`); if (/Read_Status: To Read/.test(g.data.extra ?? "")) { ok = true; break; } await Bun.sleep(200); }
	t.check(ok, "a new item is labelled To Read by the notifier handler");
};
