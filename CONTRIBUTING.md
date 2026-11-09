# Contributing

## Please read this first

Zinc is a fun side project that solved some of my own pain points. It is not run like a traditional open-source project:

- **I probably won't have time to maintain it in the usual way.** I may not be able to review every issue or pull request, or reply to them quickly, or at all.
- **There is no warranty.** I can't guarantee anyone's library, attachments or citations, and I can't offer support. Zinc writes to your Zotero data, so keep backups and test on a copy first. The licence ([AGPL-3.0](LICENSE)) says the same in legal terms: the software is provided "as is", without warranty of any kind.
- **Want to take it further?** If you are interested in taking Zinc forward and maintaining it properly as a true open-source project, please contact me through my GitHub profile, [@ABorakati](https://github.com/ABorakati).

Contributions are licensed under the AGPL-3.0, like the rest of the project.

## Running the CI checks locally

CI (`.github/workflows/ci.yml`) runs on every push and pull request. Everything it runs works on this machine too.
Bun 1.4.4 only (no node/npm). Run from the repo root.

This is the short version. The full developer guide (architecture, building, testing, database migrations, releasing) is in
[`docs/developer-guide/`](docs/developer-guide/README.md), and the user documentation in [`docs/`](docs/README.md). To read the docs with search
on this machine, run `bun run docs:dev` (or `bun run docs:preview`) from the repo root.

## One-time setup

```
cd core         && bun install --frozen-lockfile
cd word/sidebar && bun install --frozen-lockfile     # the fuzz tests import word/sidebar/src
cd gpui-ui      && bun install --frozen-lockfile
```

`core/vendor/` and the root `vendor/` are git-ignored. A fresh checkout needs:

```
bun core/scripts/fetch-zotero-vendor.ts    # Zotero translators etc., pinned commits, ~10 s (skips if already there)
```

Two other pieces cannot be fetched and are not in CI. Their tests skip when the file is missing (`core/test/needs.ts`):

| Missing piece | Where it comes from | Tests that skip |
| --- | --- | --- |
| `core/vendor/fulltext-wasm/fulltext.wasm` | built from `~/zotero-fulltext` (separate private repo) | `core/test/fulltext/*`, which are the Find Full Text engine tests |
| `vendor/document-worker/build/` | `scripts/build-docworker.sh` (clones zotero/document-worker, webpack) | `core/test/extract`, "retrieve metadata for PDFs" in `core/test/additems` |

`core/src/fulltext/wasm.ts` imports the wasm at load time, so without the file most of the core suite fails to load. CI (and a fresh clone)
creates an empty placeholder: `mkdir -p core/vendor/fulltext-wasm && : > core/vendor/fulltext-wasm/fulltext.wasm`.

## The checks

```
# core: typecheck, tests (includes the quick fuzz suite)
cd core && bun check && bun test --timeout 30000

# gpui-ui: typecheck, tests (pure-logic only; the native-window scripts are not run)
cd gpui-ui && bun check && bun test --timeout 30000

# Word sidebar: typecheck, tests (the Word end-to-end tests skip without Word)
cd word/sidebar && bun check && bun test

# Word add-in (.NET Framework 4.8). -o keeps it out of word/dist.
dotnet build word/addin/ZoteroNextWord.csproj -c Release -nologo -v q -o "$TEMP/addin-out"
```

Typecheck with `bun check`, not `tsc`.

Tests that need this machine's data skip themselves: the zotero-db writer tests need `~/Zotero/zotero.sqlite`, and the real-copy sync test
needs it plus `data/library.sqlite` (override with `ZN_TEST_ZOTERO_DIR` / `ZN_TEST_LIBRARY`). To see what a CI machine sees, run with
`USERPROFILE` pointed at an empty folder.

## Fuzzing

The fuzz suite (`core/test/fuzz`, fast-check) is part of `bun test`: ~150 cases per property, a random seed per run. A failure prints
`[fuzz] FAILED <name>` and a `replay:` line:

```
ZN_FUZZ_SEED=123 ZN_FUZZ_PATH="4:2:1" bun test core/test/fuzz/<file> -t "<property name>"
```

The nightly workflow (`.github/workflows/fuzz-nightly.yml`) runs it with `ZN_FUZZ_RUNS=5000` and uploads the failure seeds as an
artifact. Run the same locally with `ZN_FUZZ_RUNS=5000 bun test test/fuzz` in `core/`. The workflow also has a manual trigger
(Actions tab, "Run workflow") with a runs and a seed field.
