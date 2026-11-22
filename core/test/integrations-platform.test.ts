// The Word add-in and browser connector installers are Windows-only: elsewhere every call answers a stable "unsupported" and starts nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleIntegrationsApi, setIntegrationsPlatform } from "../src/integrations/api";

const realSpawn = Bun.spawn;
let spawned: unknown[][];
beforeEach(() => {
	spawned = [];
	(Bun as any).spawn = (...a: unknown[]) => {
		spawned.push(a);
		throw new Error("no process may be started on this platform");
	};
});
afterEach(() => {
	(Bun as any).spawn = realSpawn;
	setIntegrationsPlatform();
});

const call = (method: string, path: string) => handleIntegrationsApi(new Request(`http://x${path}`, { method }));

describe("integrations off Windows", () => {
	for (const platform of ["linux", "darwin"]) {
		test(`${platform}: status says unsupported and nothing is started`, async () => {
			setIntegrationsPlatform(platform);
			const r = (await call("GET", "/api/integrations"))!;
			expect(r.status).toBe(200);
			const s = (await r.json()) as any;
			expect(s.unsupported).toBe(true);
			expect(s.word).toMatchObject({ installed: false, available: false, wordRunning: false });
			expect(s.chrome).toMatchObject({ hostInstalled: false, available: false });
			expect(spawned).toEqual([]);
		});

		test(`${platform}: every action answers 501 unsupported and nothing is started`, async () => {
			setIntegrationsPlatform(platform);
			for (const p of ["word/install", "word/uninstall", "chrome/install", "chrome/uninstall", "chrome/open"]) {
				const r = (await call("POST", `/api/integrations/${p}`))!;
				expect(r.status).toBe(501);
				expect(await r.json()).toMatchObject({ unsupported: true });
			}
			expect(spawned).toEqual([]);
		});
	}
});
