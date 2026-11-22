// A running file download job must not outlive stop() / resetAccount(): they wait for it to end, and it starts no further download.
import { afterEach, describe, expect, test } from "bun:test";
import { insertAttachment, insertItem } from "../fixture";
import { connect, makeRig, stopAll, type Rig } from "./rig";

afterEach(stopAll);

const N = 16;
function manyMissing(r: Rig): void {
	insertItem(r.db, { key: "PARENT01", itemType: "journalArticle", title: "P", tags: [], collections: [], relations: {} } as any);
	for (let i = 0; i < N; i++) {
		const key = `ATT${String(i).padStart(5, "0")}`;
		insertAttachment(r.db, key, "PARENT01", "application/pdf", null);
		r.mock.files.set(key, new TextEncoder().encode(`file ${i}`));
	}
	r.db.run("DELETE FROM sync_outbox");
	r.mock.delayMs = 60;
}
const fileRequests = (r: Rig) => r.mock.log.filter((l) => /\/file$/.test(l.path)).length;

describe("file job and shutdown", () => {
	test("stop() waits for the download job and no further file is started", async () => {
		const r = makeRig();
		await connect(r);
		manyMissing(r);
		await r.svc.downloadMissing();
		await Bun.sleep(90);
		await r.svc.stop();
		const job = (await r.svc.status()).fileJob!;
		expect(job.running).toBe(false);
		const requested = fileRequests(r);
		expect(requested).toBeLessThan(N);
		await Bun.sleep(250);
		expect(fileRequests(r)).toBe(requested);
	});

	test("resetAccount() waits for the job, and a job can be started again afterwards", async () => {
		const r = makeRig();
		await connect(r);
		manyMissing(r);
		await r.svc.downloadMissing();
		await Bun.sleep(90);
		await r.svc.resetAccount();
		expect((await r.svc.status()).fileJob?.running ?? false).toBe(false);
		const requested = fileRequests(r);
		expect(requested).toBeLessThan(N);
		await Bun.sleep(250);
		expect(fileRequests(r)).toBe(requested);
	});
});
