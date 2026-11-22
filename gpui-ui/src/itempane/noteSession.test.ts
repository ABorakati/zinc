// bun test src/itempane/noteSession.test.ts -- saving a note must survive the editor going away (a note switch unmounts it, and the
// pane state its props read from is gone by then), overlapping saves, failed saves and reopening the same note at once.
import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createEffect, createRoot, createSignal, mergeProps, on, onCleanup, Show } from "solid-js";
import { flushNoteSessions, noteSettled, openNoteSession, type NoteSession } from "./noteSession";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake store: patch() records and can be slowed or failed per call. */
function backend() {
	const writes: string[] = [];
	let failNext = 0;
	let hold: Promise<void> | null = null;
	const patch = async (key: string, html: string) => {
		const gate = hold;
		if (gate) await gate;
		if (failNext > 0) {
			failNext--;
			throw new Error("offline");
		}
		writes.push(`${key}<-${html}`);
	};
	return {
		writes,
		patch,
		failNext: (n = 1) => (failNext = n),
		holdSaves() {
			let release!: () => void;
			hold = new Promise<void>((r) => (release = r));
			return () => {
				hold = null;
				release();
			};
		},
	};
}

const open = (b: ReturnType<typeof backend>, key: string, extra: Partial<Parameters<typeof openNoteSession<string>>[0]> = {}) =>
	openNoteSession<string>({ key, base: "", build: (d, base) => (d === base ? null : d), patch: b.patch, delay: 15, ...extra });

const sessions: NoteSession<string>[] = [];
afterEach(async () => {
	await flushNoteSessions();
	for (const s of sessions.splice(0)) await s.close();
});
const track = (s: NoteSession<string>) => (sessions.push(s), s);

describe("note session", () => {
	test("an edit is saved after the debounce, under the key the session opened with", async () => {
		const b = backend();
		const s = track(open(b, "AAAAAAAA"));
		s.edit("one");
		expect(b.writes).toEqual([]);
		await sleep(60);
		expect(b.writes).toEqual(["AAAAAAAA<-one"]);
		expect(s.dirty).toBe(false);
	});

	test("close flushes the pending edit at once", async () => {
		const b = backend();
		const s = open(b, "AAAAAAAA", { delay: 10_000 });
		s.edit("last words");
		expect(await s.close()).toBe(true);
		expect(b.writes).toEqual(["AAAAAAAA<-last words"]);
	});

	test("an edit made during a save is saved afterwards and reported as not current", async () => {
		const b = backend();
		const seen: [string, boolean][] = [];
		const s = track(open(b, "AAAAAAAA", { onSaved: (h, current) => seen.push([h, current]) }));
		const release = b.holdSaves();
		s.edit("v1");
		const first = s.flush();
		await sleep(5);
		s.edit("v2"); // typed while v1 is on its way
		release();
		await first;
		expect(seen).toEqual([["v1", false]]);
		expect(s.dirty).toBe(true);
		expect(await s.flush()).toBe(true);
		expect(b.writes).toEqual(["AAAAAAAA<-v1", "AAAAAAAA<-v2"]);
		expect(seen.at(-1)).toEqual(["v2", true]);
	});

	test("saves are serialised: a second flush waits for the save in flight", async () => {
		const b = backend();
		const s = track(open(b, "AAAAAAAA"));
		const release = b.holdSaves();
		s.edit("v1");
		const p1 = s.flush();
		await sleep(5);
		s.edit("v2");
		const p2 = s.flush();
		await sleep(20);
		expect(b.writes).toEqual([]); // neither has been written: v2 is not racing v1
		release();
		await Promise.all([p1, p2]);
		expect(b.writes).toEqual(["AAAAAAAA<-v1", "AAAAAAAA<-v2"]);
	});

	test("a failed save stays dirty, reports the error, and the next flush retries it", async () => {
		const b = backend();
		const errors: unknown[] = [];
		const s = track(open(b, "AAAAAAAA", { onError: (e) => errors.push(e) }));
		b.failNext();
		s.edit("keep me");
		expect(await s.flush()).toBe(false);
		expect(s.dirty).toBe(true);
		expect(errors).toHaveLength(1);
		expect(b.writes).toEqual([]);
		expect(await s.flush()).toBe(true);
		expect(b.writes).toEqual(["AAAAAAAA<-keep me"]);
	});

	test("callbacks that throw (their component is gone) neither fail the save nor lose later ones", async () => {
		const b = backend();
		const boom = () => {
			throw new TypeError("Cannot read properties of undefined");
		};
		const s = track(open(b, "AAAAAAAA", { onSaved: boom, onStatus: boom }));
		s.edit("x");
		expect(await s.flush()).toBe(true);
		s.edit("y");
		expect(await s.flush()).toBe(true);
		expect(b.writes).toEqual(["AAAAAAAA<-x", "AAAAAAAA<-y"]);
	});

	test("an unchanged note is not written, and build() returning null writes nothing", async () => {
		const b = backend();
		const s = track(open(b, "AAAAAAAA", { base: "same" }));
		s.edit("same");
		expect(await s.flush()).toBe(true);
		expect(b.writes).toEqual([]);
		expect(s.dirty).toBe(false);
	});

	test("a failed save of a closed session is retried by the shutdown flush", async () => {
		const b = backend();
		const s = open(b, "AAAAAAAA");
		b.failNext();
		s.edit("late");
		expect(await s.close()).toBe(false);
		expect(b.writes).toEqual([]);
		await flushNoteSessions();
		expect(b.writes).toEqual(["AAAAAAAA<-late"]);
	});

	test("reopening a note waits for the closing editor's save, so stale text is never loaded", async () => {
		const b = backend();
		const s = open(b, "AAAAAAAA");
		const release = b.holdSaves();
		s.edit("fresh");
		void s.close();
		let settled = false;
		const w = noteSettled("AAAAAAAA").then((r) => ((settled = true), r));
		await sleep(20);
		expect(settled).toBe(false); // the load would have read the old note
		release();
		expect(await w).toBeNull(); // saved: the stored note is current
		expect(b.writes).toEqual(["AAAAAAAA<-fresh"]);
	});

	test("reopening a note whose last save failed hands back the unsaved text", async () => {
		const b = backend();
		const s = open(b, "AAAAAAAA");
		b.failNext(2); // the close and the retry in noteSettled both fail
		s.edit("not lost");
		await s.close();
		const r = await noteSettled("AAAAAAAA");
		expect(r?.html).toBe("not lost");
		r!.take();
		await flushNoteSessions();
		expect(b.writes).toEqual([]); // adopted: the new editor's session saves it
		const s2 = track(open(b, "AAAAAAAA"));
		s2.edit(r!.html);
		await s2.flush();
		expect(b.writes).toEqual(["AAAAAAAA<-not lost"]);
	});

	test("other notes' sessions are left alone by noteSettled", async () => {
		const b = backend();
		const s = track(open(b, "BBBBBBBB"));
		s.edit("b");
		expect(await noteSettled("AAAAAAAA")).toBeNull();
		expect(b.writes).toEqual([]);
	});
});

// The reactive structure of Single > NotePane > editor, with the real session: on a note switch the pane's detail() becomes undefined,
// the editor unmounts and its parent's accessor (d().data.key) throws from then on.
describe("note switch (the pane's detail goes undefined)", () => {
	function mount(b: ReturnType<typeof backend>) {
		let edit!: (v: string) => void;
		let setKey!: (k: string) => void;
		let mounts = 0;
		const dispose = createRoot((d) => {
			const [key, sk] = createSignal("NOTE_AAA");
			setKey = sk;
			const [detail, setDetail] = createSignal<{ key: string } | undefined>({ key: "NOTE_AAA" });
			createEffect(
				on(
					key,
					async (k) => {
						setDetail(undefined);
						await sleep(20);
						setDetail({ key: k });
					},
					{ defer: true },
				),
			);
			function Editor(p: { noteKey: string }) {
				mounts++;
				const s = open(b, p.noteKey); // the key is read once, now
				edit = (v) => s.edit(v);
				onCleanup(() => void s.close());
				return "editor";
			}
			const NotePane = () => {
				const dd = () => detail()!;
				return createComponent(
					Editor,
					mergeProps({
						get noteKey() {
							return dd().key;
						},
					}),
				);
			};
			const view = createComponent(Show, {
				get when() {
					return detail();
				},
				fallback: "skeleton",
				get children() {
					return createComponent(NotePane, {});
				},
			} as never);
			createEffect(() => {
				let v: unknown = view;
				while (typeof v === "function") v = (v as () => unknown)();
			});
			return d;
		});
		return { edit: (v: string) => edit(v), switchTo: (k: string) => setKey(k), mounts: () => mounts, dispose };
	}

	test("the last edit of the note being left is saved to that note", async () => {
		const b = backend();
		const m = mount(b);
		await sleep(5);
		m.edit("draft typed in A");
		m.switchTo("NOTE_BBB"); // mid-debounce
		await sleep(80);
		expect(b.writes).toEqual(["NOTE_AAA<-draft typed in A"]);
		expect(m.mounts()).toBe(2);
		m.dispose();
	});

	test("switching while a save is in flight does not drop the edit made after it", async () => {
		const b = backend();
		const m = mount(b);
		await sleep(5);
		const release = b.holdSaves();
		m.edit("one");
		await sleep(30); // the debounce fired: "one" is being written
		m.edit("two");
		m.switchTo("NOTE_BBB");
		await sleep(10);
		release();
		await sleep(60);
		expect(b.writes).toEqual(["NOTE_AAA<-one", "NOTE_AAA<-two"]);
		m.dispose();
	});

	test("an unmount whose save fails keeps the text for the next editor of that note", async () => {
		const b = backend();
		const m = mount(b);
		await sleep(5);
		b.failNext();
		m.edit("precious");
		m.switchTo("NOTE_BBB");
		await sleep(60);
		expect(b.writes).toEqual([]);
		const r = await noteSettled("NOTE_AAA"); // reopening: its own retry succeeds (the backend is back)
		expect(r).toBeNull();
		expect(b.writes).toEqual(["NOTE_AAA<-precious"]);
		m.dispose();
	});
});
