// A downloaded file is hashed once: the checksum comparison and the stored baseline use the same digest.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { insertAttachment, insertItem } from "../fixture";
import { connect, makeRig, stopAll } from "./rig";

afterEach(stopAll);

describe("download hashing", () => {
	test("md5 of a downloaded file is computed once", async () => {
		const r = makeRig();
		await connect(r);
		insertItem(r.db, { key: "PARENT01", itemType: "journalArticle", title: "P", tags: [], collections: [], relations: {} } as any);
		const bytes = new TextEncoder().encode("pdf bytes one");
		insertAttachment(r.db, "ATT00001", "PARENT01", "application/pdf", null);
		r.db.run("UPDATE items SET data = json_set(data, '$.md5', ?) WHERE key = 'ATT00001'", [createHash("md5").update(bytes).digest("hex")]);
		r.mock.files.set("ATT00001", bytes);
		const spy = spyOn(nodeCrypto, "createHash");
		try {
			await r.svc.downloadMissing();
			await r.svc.fileJobDone;
			const md5s = spy.mock.calls.filter((c) => c[0] === "md5").length;
			expect((await r.svc.status()).fileJob).toMatchObject({ done: 1, failed: 0 });
			expect(md5s).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});
});
