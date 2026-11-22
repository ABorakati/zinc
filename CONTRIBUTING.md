# Contributing

## Please read this first

Zinc is a fun side project that solved some of my own pain points. It is not run like a traditional open-source project:

- **I probably won't have time to maintain it in the usual way.** I may not be able to review every issue or pull request, or reply to them quickly, or at all.
- **There is no warranty.** I can't guarantee anyone's library, attachments or citations, and I can't offer support. Zinc writes to your Zotero data, so keep backups and test on a copy first. The licence ([AGPL-3.0](LICENSE)) says the same in legal terms: the software is provided "as is", without warranty of any kind.
- **Want to take it further?** If you are interested in taking Zinc forward and maintaining it properly as a true open-source project, please contact me through my GitHub profile, [@ABorakati](https://github.com/ABorakati).

Contributions are licensed under the AGPL-3.0, like the rest of the project.

## Recording a change

When a change is one users will notice, add an entry for it to [`CHANGELOG.md`](CHANGELOG.md), under `## [Unreleased]`, in the
section for its type: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` ([Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/)). Write it as the release notes are written: a bold title, then what changed for the user.

## Commit messages

Commit messages and pull request titles follow the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
format:

```text
type(scope): subject

Optional body, separated from the first line by a blank line.
```

The scope is optional: `type: subject` is also valid. For example:

```text
fix(word): stop a refresh freezing Word on a looping tracked-changes list
feat(itempane): fit the attachment preview to the pane's width
docs: layouts and plugins user guides
```

The rules:

- **type**: one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`, in lowercase. A
  `!` before the colon marks a breaking change: `feat(api)!: …`.
- **subject**: no full stop at the end.
- **first line**: at most 80 characters.
- **body and footer lines**: at most 100 characters each. A line with a URL may be longer.

Merge commits, and the messages git writes for `git revert` and for `fixup!` and `squash!` commits, are not checked.

The rules are in [`scripts/commit-lint.ts`](scripts/commit-lint.ts). CI checks the title and the commit messages of every pull
request with them.

### The commit-msg hook (optional)

The repository has a commit-msg hook, [`.githooks/commit-msg`](.githooks/commit-msg), which runs the same check each time you
commit, so a broken message is caught before CI sees it. Git does not turn on hooks from a cloned repository, because a hook runs
commands on your machine: each developer decides whether to turn it on. To turn it on in your clone, run this once from the
repository root:

```
git config core.hooksPath .githooks
```

`git config --unset core.hooksPath` turns it off again.

A commit whose message breaks a rule is then refused, and git keeps the message in `.git/COMMIT_EDITMSG`. `git commit --no-verify`
skips the check once. The hook needs Bun on `PATH`; without it, the hook prints a warning and lets the commit through. `core.hooksPath`
replaces `.git/hooks`, so copy any hooks of your own from there into `.githooks`. Jujutsu (`jj`) does not run git hooks; CI still
checks the pull request.

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
| `vendor/document-worker/build/` | `scripts/build-docworker.sh` (fetches zotero/document-worker at a pinned commit, webpack) | `core/test/extract`, "retrieve metadata for PDFs" in `core/test/additems` |

`core/src/fulltext/wasm.ts` imports the wasm at load time, so without the file most of the core suite fails to load. CI (and a fresh clone)
creates an empty placeholder: `mkdir -p core/vendor/fulltext-wasm && : > core/vendor/fulltext-wasm/fulltext.wasm`.

## The checks

```
# core: typecheck, tests (includes the quick fuzz suite)
cd core && bun check && bun test --timeout 30000

# gpui-ui: typecheck, tests (pure-logic only; the native-window scripts are not run)
cd gpui-ui && bun check && bun test --timeout 30000

# the interface: the real app, in the background, with real clicks and keys (Windows and macOS; docs/developer-guide/testing.md).
# A change to the interface comes with a scenario in gpui-ui/test/ui/scenarios.
cd gpui-ui && bun run test:ui

# Word sidebar: typecheck, tests (the Word end-to-end tests skip without Word)
cd word/sidebar && bun check && bun test

# Word add-in (.NET Framework 4.8). -o keeps it out of word/dist.
dotnet build word/addin/ZoteroNextWord.csproj -c Release -nologo -v q -o "$TEMP/addin-out"
```

Typecheck with `bun check`, not `tsc`.

Tests on real data are opt-in and work on copies: the zotero-db writer tests run only when `ZN_TEST_ZOTERO_DIR` names a Zotero data
folder, and the real-copy sync test only when that and `ZN_TEST_LIBRARY` (a library file) are both set. There are no default paths
(`core/test/real-data.ts`); do not add one. To see what a CI machine sees, run with `USERPROFILE` pointed at an empty folder.

## Fuzzing

The fuzz suite (`core/test/fuzz`, fast-check) is part of `bun test`: ~150 cases per property, a random seed per run. A failure prints
`[fuzz] FAILED <name>` and a `replay:` line:

```
ZN_FUZZ_SEED=123 ZN_FUZZ_PATH="4:2:1" bun test core/test/fuzz/<file> -t "<property name>"
```

The nightly workflow (`.github/workflows/fuzz-nightly.yml`) runs it with `ZN_FUZZ_RUNS=5000` and uploads the failure seeds as an
artifact. Run the same locally with `ZN_FUZZ_RUNS=5000 bun test test/fuzz` in `core/`. The workflow also has a manual trigger
(Actions tab, "Run workflow") with a runs and a seed field.
