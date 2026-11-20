import { describe, expect, test } from "bun:test";
import { applyOfficeTheme, createOfficeHost, startTaskPane } from "../../src/entry/main";

describe("createOfficeHost router", () => {
	test("routes doc.* and service calls with params (defaulting omitted params to {})", async () => {
		const seen: { which: string; params: Record<string, unknown> }[] = [];
		const host = createOfficeHost({
			createDocMethods: () => ({
				"doc.state": async (params) => {
					seen.push({ which: "doc.state", params });
					return { hasDoc: true, name: "Paper.docx" };
				},
				"doc.locate": async (params) => {
					seen.push({ which: "doc.locate", params });
					return { pos: 42 };
				},
			}),
			createServiceMethods: () => ({
				"lib.search": async (params) => {
					seen.push({ which: "lib.search", params });
					return [{ key: "ITEM0001", title: String(params.match ?? "") }];
				},
			}),
		});

		expect(await host.call("doc.state")).toEqual({ hasDoc: true, name: "Paper.docx" });
		expect(await host.call("doc.locate", { end: true })).toEqual({ pos: 42 });
		expect(await host.call("lib.search", { match: "vaswani", limit: 5 })).toEqual([{ key: "ITEM0001", title: "vaswani" }]);

		expect(seen).toEqual([
			{ which: "doc.state", params: {} },
			{ which: "doc.locate", params: { end: true } },
			{ which: "lib.search", params: { match: "vaswani", limit: 5 } },
		]);
	});

	test("rejects unknown methods (including Object.prototype names) with an Error", async () => {
		const host = createOfficeHost({
			createDocMethods: () => ({}),
			createServiceMethods: () => ({}),
		});

		await expect(host.call("doc.nonexistent")).rejects.toThrow("Unknown method: doc.nonexistent");
		await expect(host.call("popup.bogus")).rejects.toThrow("Unknown method: popup.bogus");
		await expect(host.call("toString")).rejects.toThrow("Unknown method: toString");
		await expect(host.call("constructor")).rejects.toThrow("Unknown method: constructor");
	});

	test("turns synchronous throws and async rejections into Error rejections with their message", async () => {
		const host = createOfficeHost({
			createDocMethods: () => ({
				"doc.syncThrow": () => {
					throw new Error("Track Changes is locked");
				},
				"doc.asyncReject": async () => {
					throw new Error("ItemNotFound in footnote");
				},
				"doc.plainObjectThrow": async () => {
					// Simulates cross-realm OfficeExtension.Error objects that are not instanceof Error
					// eslint-disable-next-line no-throw-literal
					throw { code: "GeneralException", message: "Word failed to sync" };
				},
				"doc.stringThrow": async () => {
					// eslint-disable-next-line no-throw-literal
					throw "raw failure";
				},
			}),
			createServiceMethods: () => ({}),
		});

		for (const [method, expected] of [
			["doc.syncThrow", "Track Changes is locked"],
			["doc.asyncReject", "ItemNotFound in footnote"],
			["doc.plainObjectThrow", "Word failed to sync"],
			["doc.stringThrow", "raw failure"],
		] as const) {
			let caught: unknown;
			try {
				await host.call(method);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toBe(expected);
		}
	});

	test("delivers ctx.emit events from doc and service parts to host.on subscribers", () => {
		let emitFromDoc!: (event: string, data: unknown) => void;
		let emitFromServices!: (event: string, data: unknown) => void;

		const host = createOfficeHost({
			createDocMethods: (ctx) => {
				emitFromDoc = (e, d) => ctx.emit(e, d);
				return {};
			},
			createServiceMethods: (ctx) => {
				emitFromServices = (e, d) => ctx.emit(e, d);
				return {};
			},
		});

		const cursorEvents: unknown[] = [];
		const cursorMirror: unknown[] = [];
		const commandEvents: unknown[] = [];

		host.on("cursor", (d) => cursorEvents.push(d));
		host.on("cursor", (d) => cursorMirror.push(d));
		host.on("command", (d) => commandEvents.push(d));

		emitFromDoc("cursor", { hasDoc: true, doc: "Draft.docx", inField: true });
		emitFromServices("command", { name: "refresh" });
		emitFromDoc("unsubscribed", { ignored: true });

		expect(cursorEvents).toEqual([{ hasDoc: true, doc: "Draft.docx", inField: true }]);
		expect(cursorMirror).toEqual([{ hasDoc: true, doc: "Draft.docx", inField: true }]);
		expect(commandEvents).toEqual([{ name: "refresh" }]);
	});

	test("provides safe stand-ins for popup.resize/edit/close and agent.*, while allowing part overrides", async () => {
		const commands: unknown[] = [];
		const host = createOfficeHost({
			createDocMethods: () => ({}),
			createServiceMethods: () => ({}),
		});
		host.on("command", (d) => commands.push(d));

		expect(await host.call("popup.resize", { height: 240 })).toEqual({ ok: true });
		expect(await host.call("popup.close")).toEqual({ ok: true });
		expect(await host.call("popup.edit")).toEqual({ ok: true });
		expect(commands).toEqual([{ name: "editCitation" }]);

		expect(await host.call("agent.ready")).toEqual({ ok: true });
		expect(await host.call("agent.result", { id: 1, ok: true })).toEqual({ ok: true });
		expect(await host.call("agent.ping")).toEqual({ ok: true });

		const overridden = createOfficeHost({
			createDocMethods: () => ({
				"popup.close": async () => ({ ok: true, custom: "closed-dialog" }),
			}),
			createServiceMethods: () => ({}),
		});
		expect(await overridden.call("popup.close")).toEqual({ ok: true, custom: "closed-dialog" });
	});
});

describe("startTaskPane and theme helper", () => {
	test("waits for Office.onReady, sets __znHost first, and then loads the sidebar", async () => {
		let triggerReady!: (info: unknown) => void;
		const readyGate = new Promise<unknown>((resolve) => {
			triggerReady = resolve;
		});

		const target: Record<string, unknown> = {};
		const order: string[] = [];

		const bootPromise = startTaskPane({
			office: {
				onReady(cb) {
					order.push("onReady-subscribed");
					return readyGate.then((info) => {
						cb?.(info);
						return info;
					});
				},
			},
			target,
			createDocMethods: () => ({
				"doc.state": async () => ({ hasDoc: true, name: "Ready.docx" }),
			}),
			createServiceMethods: () => ({}),
			loadSidebar: async () => {
				order.push(target.__znHost ? "sidebar-saw-host" : "sidebar-missing-host");
			},
		});

		expect(target.__znHost).toBeUndefined();
		triggerReady({ host: "Word" });
		const host = await bootPromise;

		expect(target.__znHost).toBe(host);
		expect(order).toEqual(["onReady-subscribed", "sidebar-saw-host"]);
		expect(await host.call("doc.state")).toEqual({ hasDoc: true, name: "Ready.docx" });
	});

	test("maps Office task-pane background hex colours onto data-office theme tokens", () => {
		const fakeDoc = { documentElement: { dataset: {} as Record<string, string> } } as unknown as Document;
		applyOfficeTheme("#fcfcfc", fakeDoc);
		expect(fakeDoc.documentElement.dataset.office).toBe("light");
		applyOfficeTheme("#3a3a3a", fakeDoc);
		expect(fakeDoc.documentElement.dataset.office).toBe("darkgray");
		applyOfficeTheme("#262626", fakeDoc);
		expect(fakeDoc.documentElement.dataset.office).toBe("black");
	});
});
