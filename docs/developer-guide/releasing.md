# Releasing

How a build becomes an installer, and how an installer becomes an update that installed copies pick up. Building each piece is covered in [Building](building.md); the user-facing side of updates is in [Updates](../user-guide/updates.md). The installer and code signing are Windows only; the Linux AppImage and the macOS disk image are described in [Linux and macOS packages](#linux-and-macos-packages).

## Overview

```
bun gpui-ui/scripts/package.ts --aot       # gpui-ui/out/package-aot/zotero-next-gpui/
bun gpui-ui/scripts/installer.ts           # gpui-ui/out/installer/Zinc-Setup-<version>.exe
bun gpui-ui/scripts/release.ts --installer <that exe> --notes <file> ...   # signs latest.json, optionally publishes
```

`installer.ts` does not rebuild the package, and `release.ts` does not build anything: it hashes the packages you give it, writes one signed manifest (feed) for each, and optionally uploads. There are four feeds: `latest.json` (Windows), `latest-linux-x64.json`, `latest-darwin-arm64.json` and `latest-extension.json` (the browser extension). A run writes the ones whose package you pass. The build that users run must already contain the matching public key (below) and be older than the release.

The browser extension (the Zinc Connector) has its own zips, workflow and store steps: see [Releasing the browser extension](extension-release.md).

## Release notes

The release notes are the version's section of `CHANGELOG.md` at the repository root ([Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)). Before a release:

1. Rename `## [Unreleased]` to `## [<version>] - <yyyy-mm-dd>` and add an empty `## [Unreleased]` above it.
2. At the end of the file, point `[unreleased]` at `compare/v<version>...HEAD` and add a `[<version>]` link to `compare/v<previous>...v<version>`.
3. Pass that section, with the install instructions, to `release.ts --notes`.

## Build provenance attestations

From 0.1.18 the files GitHub Actions builds for a release carry a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations): a statement, signed through GitHub's OIDC token and recorded in Sigstore's public log, that the file was built by a given workflow from a given commit. `actions/attest-build-provenance` runs right before each "attach to the release" step:

| Workflow | Files |
| --- | --- |
| `desktop-packages.yml` | `Zinc-<v>-x86_64.AppImage`, `Zinc-<v>-arm64.dmg`, `Zinc-<v>-arm64.app.zip` |
| `extension.yml` | `Zinc-Connector-<v>.zip`, `Zinc-Connector-<v>-store.zip` |
| `web.yml` | `Zinc-Web-v<v>.zip` |

Check one with `gh attestation verify <file> -R ABorakati/zinc`. The Windows installer is built on the release machine, not in Actions, so it has none (GitHub only attests from a running workflow); nor do the `latest*.json` feeds, which carry their own Ed25519 signatures (below).

## Code signing: not used today

Two different signatures exist. Do not confuse them.

- **Authenticode code signing** of the executables and the installer is the job of the hooks in `gpui-ui/scripts/sign.ts`. The hooks exist, but no certificate is configured and **nothing is signed today**. `package.ts` and `installer.ts` print `unsigned: no certificate configured` and carry on.
- **Update-manifest signing** (Ed25519, `release.ts`) protects the auto-update feed. It is in use and independent of code signing.

If a certificate is configured, `package.ts` signs `zotero-next-gpui.exe` and `zn_pdf.dll`; `installer.ts` signs the add-in DLL and the connector host if they are not signed yet, and the setup and uninstaller through Inno's `SignTool` hook (which calls `sign.ts`). A configured but failing signature is an error, never a silently unsigned release. `bun gpui-ui/scripts/sign.ts --check <file>` reports whether a file carries a signature.

| Variables | Signs with |
| --- | --- |
| `ZN_SIGN_PFX`, `ZN_SIGN_PFX_PASSWORD` | `signtool` from the Windows SDK |
| `ZN_SIGN_AZURE_ENDPOINT`, `ZN_SIGN_AZURE_ACCOUNT`, `ZN_SIGN_AZURE_PROFILE` | Microsoft's `sign` tool with Azure Artifact Signing; credentials come from `az login` or a managed identity (`ZN_SIGN_AZURE_CREDENTIAL`) |

Optional: `ZN_SIGN_TIMESTAMP` (`none` to skip), `ZN_SIGN_TOOL`, `ZN_SIGN_DESCRIPTION`. `ZN_PUBLISHER` sets the installer's publisher name and should match the certificate subject if one is used. The file `gpui-ui/installer/README.md` has the full text and notes on the kinds of certificate.

## The version stamp

`gpui-ui/scripts/_version.ts` computes one stamp that `build.ts` bakes into the executable, `package.ts` writes to `version.txt`, and `installer.ts` uses for the installer.

```
<release>+<commit>-<yyyymmdd>        for example 0.1.0+1a2b3c4d-20261106
```

- `<release>` is `ZN_RELEASE`, default `0.1.0`.
- `<commit>` is the first 8 characters of the repository commit (from `jj log -r @-` if available, else `git rev-parse --short=8 HEAD`, else `unknown`).
- `<yyyymmdd>` is the build date (UTC).

`ZN_BUILD_VERSION` overrides the whole stamp. The first import sets it in the environment so child processes (the AOT build under the canary Bun, the installer's sign hook) see the same value even if a build crosses midnight. `bun gpui-ui/scripts/_version.ts` prints the stamp, and with `--numeric` the four-number form.

The numeric form that installers and Windows version resources need is `major.minor.<days since 2026-01-01>.0`, a pure function of the stamp, so it rises with the build date.

Version comparison (`core/src/update/version.ts`): the numeric release part first, then a pre-release tag (`0.2.0-beta.1` is older than `0.2.0`), then the build date. The commit is not ordered, so two builds of one release on the same day are equal. A development build (`ZN_VERSION` unset) is never offered an update.

## The installer

`bun gpui-ui/scripts/installer.ts` writes `gpui-ui/out/installer/Zinc-Setup-<version>.exe` (the `+` in the stamp becomes `-`) and `Zinc-Setup-<version>.json` with the version, size and SHA-256. It uses Inno Setup 7 and `gpui-ui/installer/zotero-next.iss`. Options and how Inno Setup is found are in [Building](building.md). In short, it is a per-user install with no admin rights into `%LOCALAPPDATA%\Programs\Zinc`, with optional components for the Word add-in and the browser connector, and it upgrades in place (same AppId). It never touches the library, logs or settings; the uninstaller asks before removing settings and logs.

### Command lines

```
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART                  silent install or upgrade (what the updater runs)
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH      ... and start the app afterwards
Setup.exe ... /COMPONENTS="app" | "app,word" | "app,word,connector"  /TASKS="desktopicon"  /DIR="..."  /LOG="file"
unins000.exe /VERYSILENT /SUPPRESSMSGBOXES [/REMOVEDATA]           silent uninstall (/REMOVEDATA also removes settings and logs)
```

Test hooks: `/ZNTESTHIVE="file"` registers the Word add-in into a private registry hive instead of HKCU, and `/ZNAPPDATA="dir"` redirects the "remove settings" step. `installer.ts --test` builds an installer with its own AppId and name for sandbox runs; it registers the connector host as `com.zotero_next.connector_host_test` so it never replaces a real registration.

A running app is detected. Interactively the user is asked to close it; in a silent run the app is closed gracefully (WM_CLOSE, 15 s) or the install fails. If Word is open, the add-in is left as it is.

## Update keys

Updates are verified with an Ed25519 key pair.

1. Generate it once, outside the repository:

   ```
   bun gpui-ui/scripts/release.ts --keygen <folder-outside-the-repo>
   ```

   This writes `release-key.private.json` (secret: back it up and never commit it; losing it means shipping a new public key in a new build by hand) and `release-key.public.txt`. The script refuses a folder inside the repository and refuses to overwrite existing key files.

2. Embed the public key in every build that should be able to update. `gpui-ui/scripts/_update-key.ts` reads, first hit wins:
   - `ZN_UPDATE_PUBKEY`, the raw base64 key;
   - `ZN_UPDATE_PUBKEY_FILE`, a file holding it (for example `release-key.public.txt`);
   - `gpui-ui/update-pubkey.txt`, which may be committed because a public key is not secret. The repository commits the release public key there, so a local build embeds it with no setup.

   An empty `ZN_UPDATE_PUBKEY` counts as unset, because CI passes an unset variable as an empty string. `.github/workflows/desktop-packages.yml` reads the repository variable `ZN_UPDATE_PUBKEY` (Settings, Secrets and variables, Actions, Variables), so a value there overrides the file for the AppImage and the disk image. Keep the variable and the file the same key. `build.ts` bakes the key into the executable. A build with no key prints a warning, cannot verify any manifest and never updates. A packaged executable cannot be pointed at another key by an environment variable.

3. The private key is read only by `release.ts`, from the path in `ZN_UPDATE_KEY`. The script refuses a path inside the repository.

The default feed URL is baked in at build time. It is `ZN_UPDATE_URL` (an https URL of `latest.json`) when that is set and not empty, otherwise `DEFAULT_UPDATE_URL` in `gpui-ui/scripts/_update-key.ts`: `https://github.com/ABorakati/zinc/releases/latest/download/latest.json`, the `latest.json` of the latest GitHub release. `desktop-packages.yml` passes the repository variable `ZN_UPDATE_URL` the same way. A user can override the URL in Settings under System, Updates. The Linux and macOS builds read their own file next to it. A build with no public key never updates, and an unpackaged run with `ZN_UPDATE_URL` unset has no default feed, so nothing is requested.

## `release.ts`

```
ZN_UPDATE_KEY=<path to release-key.private.json> \
bun gpui-ui/scripts/release.ts [--installer <Zinc-Setup-....exe>] [--appimage <file>] [--mac-app <file>] [--extension-zip <zip>] [options]
```

Pass at least one package. Each one gets its own signed feed in `--out`:

| Package option | Feed written |
| --- | --- |
| `--installer` | `latest.json` (Windows, no `platform` field) |
| `--appimage` | `latest-linux-x64.json` (`"platform": "linux-x64"`) |
| `--mac-app` | `latest-darwin-arm64.json` (`"platform": "darwin-arm64"`; `darwin-x64` when the file name says `-x64`) |
| `--extension-zip` | `latest-extension.json`, see [The Zinc Connector's feed](#the-zinc-connectors-feed-latest-extensionjson) |

| Option | Meaning |
| --- | --- |
| `--version <stamp>` | Default per package: the installer's file name; for the AppImage and the app zip, the `<file>.version` next to them (`appimage.ts` and `dmg.ts` write it); else the package's `version.txt`. It must be the version built into that package, or the updated app is offered the update again. The connector zip is the exception: its own version wins (below) |
| `--notes <file or text>` | Release notes, Markdown (default `Zinc <version>`) |
| `--url <https url>` | Where users download the package (one package only; with `--publish` it defaults to the GitHub release asset URL) |
| `--base-url <https url>` | Where users download the packages: `<base-url>/<file name>`, for any number of packages. It also covers the connector zip |
| `--min-version <v>` | Older installs cannot update in place and are told to install by hand |
| `--out <dir>` | Where the feeds go (default `gpui-ui/out/release`) |
| `--publish <owner/repo>` | Run `gh release create` on that repository with the packages, the feeds and any `--attach` files |
| `--attach <file>` | Another file for the release (the `.dmg`, `.sha256` files). May be repeated |
| `--tag <tag>` | Release tag (default `v<version>`) |
| `--dry-run` | With `--publish`: print the `gh` command instead of running it |
| `--force` | Skip the check that the key matches the public key builds embed |

It hashes each package, signs its manifest, verifies its own output, and refuses a private key that does not match the public key builds embed. Without `--publish` it uploads nothing. Always preview first:

```
bun gpui-ui/scripts/release.ts --installer <setup.exe> --notes notes.md --publish <owner>/<releases-repo> --dry-run
```

With `--publish` it runs `gh release create <tag> <packages> <feeds> --repo <owner>/<repo> --title "Zinc <version>" --notes-file <notes> --latest`, so `gh` must be installed and logged in. Publishing is a deliberate act; do not run it from automation without a human decision.

## `latest.json`

```json
{
  "version": "0.2.0+1a2b3c4d-20261201",
  "releasedAt": "2026-12-01T09:00:00Z",
  "notes": "# 0.2.0\n- ...markdown...",
  "url": "https://<host>/<path>/Zinc-Setup-0.2.0-1a2b3c4d-20261201.exe",
  "sha256": "<64 hex characters>",
  "size": 123456789,
  "minVersion": "0.1.0",
  "signature": "<base64 Ed25519>"
}
```

`minVersion` is optional. The signature is Ed25519 over the manifest without `signature`, as canonical JSON: object keys sorted, no whitespace, UTF-8. Every other field is signed, so changing the URL, hash, size, version or notes invalidates it. Unknown fields are rejected. The code is `core/src/update/manifest.ts`.

## The Zinc Connector's feed (`latest-extension.json`)

Unpacked installs of the browser extension cannot update themselves, so the extension (`src/browserExt/updateNotice.js` in the connector repository) checks a signed feed once a day and shows a notice in its save popup. Store installs have an `update_url` in their manifest and skip the check. Pass the unpacked zip to `release.ts`:

```
bun gpui-ui/scripts/release.ts --extension-zip Zinc-Connector-<version>.zip [--installer <setup.exe>] --publish <owner>/<repo> --dry-run
```

`--installer` may be left out for a connector-only release. This writes `latest-extension.json` next to `latest.json`, with the same fields (without `minVersion`), the same key and the same signing; `url` is the release asset `Zinc-Connector-<version>.zip` (or `--extension-url`, or `--base-url` plus the file name). With `--publish` the zip and the feed are uploaded to the release. The extension embeds the public key at build time: run `bun scripts/gen-update-key.ts <path to gpui-ui/update-pubkey.txt>` in the connector repository before building (an empty key means no notice). The extension compares the feed's `version` with its manifest `version_name` (else `version`). The feed carries the connector's own version, taken from the zip's file name (then `--version`, then the app package's), not the app's build stamp. An app stamp such as `0.1.11+1a2b3c4d-20261116` would count as newer than the extension's own `0.1.11` for ever.

## The feed and the update flow

The feed is `latest.json` at an https URL (plain http is accepted for localhost only, for tests). It must be fetchable by the installed apps without credentials, so the hosting choice matters:

- `ABorakati/zinc` is public, so its release assets download without credentials: the default feed is `https://github.com/ABorakati/zinc/releases/latest/download/latest.json`, so `release.ts --publish` makes a new release the one installed apps find. (A private repository's assets cannot be downloaded anonymously; it would need the feed hosted elsewhere.) The signature on the manifest, not the host, protects users.
- For your own machine only, `ZN_UPDATE_TOKEN` (a GitHub token) is sent as a bearer token to the feed's own origin and nowhere else. Do not ship a token to users.

What the app does (`core/src/update/`, `gpui-ui/src/update/`):

- It checks about 20 seconds after the first items load, then every 24 hours, if "Check automatically" is on (default). "Download automatically" is off by default. "Check now" always works.
- It downloads to `%LOCALAPPDATA%\zotero-next-gpui\updates\zotero-next-<version>-setup.exe`, resumable. Size and SHA-256 must match the signed manifest or the file is deleted; it is verified again right before running.
- "Install now" closes the database cleanly, starts the installer detached with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH` and exits. "Install on exit" does the same at the next normal quit, without `/ZNRELAUNCH`. A crash exit installs nothing. `ZN_INSTALLER_ARGS` (a JSON array, with `{pid}` and `{file}` placeholders) overrides the arguments.
- The relaunched app is started from the old one, so it inherits the old process's environment. A packaged app replaces an inherited `ZN_PDF_DLL`, `ZN_ROOT`, `ZN_READER_HOST`, `ZN_NOTE_HOST`, `ZN_ZOTERO_VENDOR` or worker path that points into another Zinc package folder, or at nothing, so the new version loads its own files. Other values stay as the user's overrides (`gpui-ui/src/packagedEnv.ts`).
- Logs go to `%APPDATA%\zotero-next-gpui\logs`, area `update`.

## Release checklist

This is the Windows installer. The Linux and macOS packages follow [the section below](#linux-and-macos-packages).

1. Check `main` is green in CI and run the checks in [Testing](testing.md).
2. Decide the release number (`ZN_RELEASE`) and build with `bun gpui-ui/scripts/package.ts --aot` (the committed `gpui-ui/update-pubkey.txt` and the default feed URL are used unless you override them). On the release machine this uses the local Windows canary; elsewhere the pinned npm canary is downloaded (see [Building](building.md#the-aot-canary)).
3. Build the installer with `bun gpui-ui/scripts/installer.ts`. Install it on a clean machine or in a sandbox (`--test`) and check a silent upgrade over the previous version.
4. Check the packaged app itself, as it ships: `cd gpui-ui && bun test/ui/real/smoke.ts --app out/package-aot/zotero-next-gpui/zotero-next-gpui.exe`. It runs the executable on a background desktop with a throwaway library (never on screen, never on your data) and checks the top rows, the library, the item pane and Settings. Look at the screenshots it leaves in `out/ui-real` too: a test window can differ from the real one.
5. Run `release.ts` with `--dry-run`, read the command, then publish.
6. Check that an installed older build offers the update and installs it.

## Linux and macOS packages

The AppImage (`gpui-ui/scripts/appimage.ts`) and the macOS app (`gpui-ui/scripts/dmg.ts`, which also writes `Zinc-<release>-arm64.app.zip` for updates) update themselves from their own signed feeds, `latest-linux-x64.json` and `latest-darwin-arm64.json`, next to the Windows `latest.json`. Publish all three with one `release.ts` run (`--installer`, `--appimage`, `--mac-app`, with `--extension-zip` for the connector feed too); the feed format and the self-replacement are in `gpui-ui/UPDATES.md`. The disk image itself is only for first installs (`--attach`). How each package is built is in [Building](building.md#linux-and-macos).

`.github/workflows/desktop-packages.yml` builds both and attaches them to a release. It runs when a release is published, and by hand. Jobs:

| Job | Runner | What it does |
| --- | --- | --- |
| `web-parts` | `ubuntu-24.04` | Builds the parts that are the same on every OS, once: Zotero's document worker, the reader page (`reader-host/dist`, from `zotero/reader` at the commit in `ZOTERO_READER_COMMIT`) and the note editor page (`note-host/dist`). Passes them on as one artifact |
| `appimage` | `ubuntu-24.04` | Unpacks the parts, installs `core` and `gpui-ui`, fetches the vendored Zotero code, makes the empty fulltext placeholder, runs `bun scripts/appimage.ts` (bytecode by default, `--aot` with `linux_build=aot`) |
| `dmg` | `macos-15` | The same steps, then the AOT package (`package.ts --aot`), a start check of it (`scripts/start-check.ts`) and `bun scripts/dmg.ts --aot --no-package`. If any of these fails, `bun scripts/dmg.ts` (bytecode) instead |
| `release-appimage`, `release-dmg` | `ubuntu-24.04` | Only for a release. They take the finished files from the artifact of `appimage` or `dmg`, sign the provenance statement and attach the files. They check out nothing and run no repository code; they are the only jobs with a write token. The build jobs run with a read-only token |

**Which build each package is.** The Windows installer is always the AOT build. The macOS disk image is AOT by default; the AppImage is bytecode by default, because on Linux Bun's AOT executables turn on memory-deny-write-execute and then crash wherever Vulkan is software-rendered (details in [Building](building.md#the-aot-canary)). A run by hand chooses with `mac_build` and `linux_build` (`aot` or `bytecode`); a published release uses the defaults. Both jobs get the Bun canary themselves (`gpui-ui/scripts/_bun-canary.ts`: the pinned npm canary, SHA-512-checked, cached between runs) and run under the stable Bun of `BUN_VERSION`. A failed AOT build never blocks a release: the job builds the bytecode package instead, with a warning, and the job summary says which build each package is. Check that summary before you announce a release. The fulltext wasm in CI is an empty placeholder, so `build.ts` leaves out the AOT patch that compiles it; Find Full Text is not in those builds anyway.

The version comes from the tag: the workflow sets `ZN_RELEASE` to the tag without its leading `v` (`v0.1.10` gives `0.1.10`), or `0.1.0` when there is no tag. The files are named `Zinc-<version>-x86_64.AppImage` and `Zinc-<version>-arm64.dmg`, each with a `.sha256` file. Both jobs also keep the files as the artifacts `zinc-appimage` and `zinc-dmg`.

To attach the packages to a release that exists already:

```
gh workflow run desktop-packages.yml -f release_tag=v0.1.10
gh workflow run desktop-packages.yml -f mac_build=bytecode -f linux_build=aot   # other builds, artifacts only
```

With an empty `release_tag` a manual run only builds and keeps the artifacts. Pinning a new `zotero/reader` commit means changing `ZOTERO_READER_COMMIT` in the workflow; the reader cache key includes it. The document worker is built from the commit in `DOCWORKER_COMMIT` in `scripts/build-docworker.sh`, and the workflows' cache key is a hash of that script. Every action in the workflows is pinned to a full commit with its version in a comment (`scripts/workflows.test.ts` checks this); to update one, look up the new commit of its release tag and change both.

The workflow does not run on every push, only on releases and by hand: the macOS job can wait a long time for a runner. A separate workflow, `macos.yml`, runs the tests, builds the native PDF library and smoke-tests the app window on `macos-15`; it runs by hand and when code that differs per OS changes on `main`.

The disk image is signed ad hoc and not notarised, and the AppImage is not signed.

The website, with this documentation, is published on GitHub Pages at https://aborakati.github.io/zinc/ by `web.yml` on every push to `main` that changes it. The workflow builds the site under the base path `/zinc/` and its `pages` job deploys it (the repository's Pages source is "GitHub Actions"). The repositories, `ABorakati/zinc` and `ABorakati/zinc-connector`, are public.
