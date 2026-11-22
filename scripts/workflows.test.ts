// Rules the GitHub workflows (.github/workflows) must keep. They cannot be run here, so this reads them: it parses every file and
// checks the structure that matters for supply-chain safety and for the hand-off of release files between jobs.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", ".github", "workflows");
interface Step {
	uses?: string;
	with?: Record<string, unknown>;
	run?: string;
	name?: string;
}
interface Job {
	needs?: string | string[];
	permissions?: Record<string, string>;
	steps?: Step[];
	if?: string;
}
interface Workflow {
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));
const text = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const parse = (f: string): Workflow => Bun.YAML.parse(text(f)) as Workflow;
const needsOf = (j: Job) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
const WRITE = /^(write|write-all)$/;
const writes = (p?: Record<string, string>) => Object.values(p ?? {}).some((v) => WRITE.test(v));

describe("workflows", () => {
	test("there are workflows to check", () => {
		expect(files.length).toBeGreaterThanOrEqual(7);
	});

	test("every action is pinned to a full commit with a version comment", () => {
		for (const f of files) {
			for (const line of text(f).split("\n")) {
				const m = line.match(/^\s*(?:- )?uses:\s*(\S+)(.*)$/);
				if (!m || m[1]!.startsWith("./")) continue;
				expect(m[1], `${f}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
				expect(m[2], `${f}: ${line.trim()}`).toMatch(/^\s+# v\d/);
			}
		}
	});

	test("no checkout leaves credentials in the work tree", () => {
		for (const f of files) {
			for (const [id, job] of Object.entries(parse(f).jobs)) {
				for (const s of job.steps ?? []) {
					if (s.uses?.startsWith("actions/checkout@")) expect(s.with?.["persist-credentials"], `${f} ${id}`).toBe(false);
				}
			}
		}
	});

	test("the token is read-only except in the jobs that attach files, and those run no repository code", () => {
		for (const f of files) {
			const wf = parse(f);
			expect(writes(wf.permissions), `${f}: workflow-level permissions`).toBe(false);
			for (const [id, job] of Object.entries(wf.jobs)) {
				if (!writes(job.permissions)) continue;
				expect(id, `${f}: ${id} has write permissions`).toMatch(/^(release|pages)/);
				for (const s of job.steps ?? []) {
					expect(s.uses ?? "", `${f} ${id}`).not.toMatch(/^(actions\/checkout|oven-sh\/setup-bun|actions\/cache)@/);
					if (s.run) expect(s.run, `${f} ${id}`).toMatch(/^gh release upload /);
				}
			}
		}
	});

	test("every artifact a release job downloads is uploaded by a job it depends on, and only that is used", () => {
		for (const f of files) {
			const wf = parse(f);
			for (const [id, job] of Object.entries(wf.jobs)) {
				if (!id.startsWith("release")) continue;
				const downloads = (job.steps ?? []).filter((s) => s.uses?.startsWith("actions/download-artifact@"));
				expect(downloads.length, `${f} ${id}`).toBe(1);
				const dl = downloads[0]!;
				const name = String(dl.with?.name);
				const dir = String(dl.with?.path);
				// the job that uploads it is one of its needs (or behind one)
				const reach = new Set<string>();
				const walk = (j: string) => {
					if (reach.has(j)) return;
					reach.add(j);
					for (const n of needsOf(wf.jobs[j]!)) walk(n);
				};
				for (const n of needsOf(job)) walk(n);
				const uploader = [...reach].find((j) =>
					(wf.jobs[j]!.steps ?? []).some((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === name),
				);
				expect(uploader, `${f} ${id}: nothing uploads "${name}"`).toBeDefined();
				// everything the job attests and uploads comes from the download folder
				const paths: string[] = [];
				for (const s of job.steps ?? []) {
					if (s.uses?.startsWith("actions/attest-build-provenance@")) paths.push(...String(s.with?.["subject-path"]).split("\n"));
					if (s.run) paths.push(...(s.run.match(/\S+\*?\.\S+/g) ?? []).filter((w) => /\.(zip|AppImage|dmg|sha256|version)\b/.test(w)));
				}
				expect(paths.length, `${f} ${id}`).toBeGreaterThan(0);
				for (const p of paths.map((x) => x.replace(/^"|"$/g, "").trim()).filter(Boolean))
					expect(p.startsWith(dir + "/"), `${f} ${id}: ${p} is not under ${dir}/`).toBe(true);
			}
		}
	});

	test("the upload steps of the build jobs send exactly what the release jobs read", () => {
		// web.yml: the zip, flat; extension.yml: the zips; desktop-packages.yml: package, checksum and stamp files
		const web = parse("web.yml");
		const up = web.jobs.build!.steps!.find((s) => s.with?.name === "zinc-web-zip")!;
		expect(up.with!.path).toBe("gpui-ui/out/Zinc-Web-*.zip");
		expect(up.if).toBe("github.event_name == 'release' || inputs.release_tag != ''");
		const ext = parse("extension.yml");
		expect(ext.jobs.extension!.steps!.find((s) => s.with?.name === "zinc-connector-zips")!.with!.path).toBe("ext-out/*.zip");
		expect(parse("desktop-packages.yml").jobs["release-appimage"]!.needs).toBe("appimage");
		expect(parse("desktop-packages.yml").jobs["release-dmg"]!.needs).toBe("dmg");
	});

	test("the document worker is built from one commit, which is in the cache key through the script", () => {
		const script = readFileSync(join(import.meta.dir, "build-docworker.sh"), "utf8");
		expect(script).toMatch(/^DOCWORKER_COMMIT=[0-9a-f]{40}$/m);
		expect(script).not.toMatch(/git clone/);
		for (const f of ["web.yml", "desktop-packages.yml", "extension.yml"]) expect(text(f)).toContain("scripts/build-docworker.sh");
		for (const f of ["web.yml", "desktop-packages.yml"]) expect(text(f)).toContain("docworker-${{ hashFiles('scripts/build-docworker.sh') }}");
		expect(text("extension.yml")).toContain("hashFiles('zotero-next/reader-host/build.sh', 'zotero-next/scripts/build-docworker.sh')");
	});

	test("the Zotero reader is a full commit", () => {
		for (const f of ["extension.yml", "desktop-packages.yml"]) {
			expect(text(f)).toMatch(/READER_COMMIT: [0-9a-f]{40}\b/);
		}
	});
});
