# Auto-update

Zinc checks a signed feed, downloads the update, verifies it and installs it: on Windows by running the installer silently, on Linux
by replacing its AppImage file, on macOS by swapping Zinc.app. Nothing happens until you publish a feed and embed a public key in the build.

## How it works

- **Feed**: one signed manifest per platform, side by side at any https URL (plain http is accepted only for localhost, for tests):
  `latest.json` (Windows), `latest-linux-x64.json` (the AppImage) and `latest-darwin-arm64.json` (Zinc.app, zipped). The feed URL names
  `latest.json`; Linux and macOS builds read their own file next to it (a URL that does not end in `/latest.json` is used as it is).
- **Check**: ~20 s after the first items are in, then every 24 h (the time of the last check is kept, so a restart does not re-check early).
  Settings > System > Updates has "Check automatically" (on), "Download automatically" (off), "Check now", the version, the last result
  and the feed URL. With "Check automatically" off nothing is requested (Check now still works, being an explicit action).
  With no feed URL configured nothing is ever requested.
- **Found**: a toast, "Zinc X is available", with *What's new* (release notes dialog), *Install on exit* and *Install now*.
  Versions compare by the numeric release part, then pre-release tag, then the build date suffix (`0.1.0+b7cd9fc4-20261106`; the commit id is not ordered).
  A development build (`ZN_VERSION` unset) is never offered an update.
- **Download**: `%LOCALAPPDATA%\zotero-next-gpui\updates\zotero-next-<version>-setup.exe`, resumable (`.part` + HTTP Range). Size and SHA-256 must match
  the signed manifest, else the file is deleted. It is verified again right before it runs. Old installers are deleted after a check.
- **Install now**: waits for pending writes, closes the database (the app's shutdown closers), starts the installer detached with
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH`, exits.
  **Install on exit**: the same at the next normal quit (exit code 0), without `/ZNRELAUNCH`. A crash exit installs nothing.
- **Linux (AppImage)**: the AppImage runtime sets `APPIMAGE` to the file. The update downloads next to it as
  `.zinc-update-<version>.AppImage.download` (same folder, so the swap is one atomic rename; hidden, and not `*.AppImage`, so an AppImage
  manager does not pick it up), is verified and made executable, and at exit is renamed over `$APPIMAGE`. The running app keeps the old file
  open, so this is safe. Install now then starts the new AppImage once the old process is gone. Not started from an AppImage, or a folder
  the app cannot write: the update is shown as "install by hand", with the reason.
- **macOS (Zinc.app)**: the update is `Zinc-<release>-arm64.app.zip` (`ditto -c -k --keepParent`, made by `dmg.ts`). It downloads to
  `~/Library/Application Support/zotero-next-gpui/updates`, is verified, and is unpacked (`ditto -x -k`) into `.zinc-update/` next to the
  bundle (same volume). Its quarantine flag is removed and `codesign --verify --deep --strict` must pass; if it does not, it is signed ad hoc
  and checked again. At exit a detached `/bin/sh` helper (`.zinc-update/apply.sh`) waits for the app's pid (2 min at most), moves the old
  bundle into `.zinc-update/`, moves the new one into place (the old one goes back if that fails), deletes `.zinc-update/` and, for Install
  now, runs `open` on the app. It logs to `updates/apply.log`. A bundle in a folder the app cannot write (for example the disk image itself)
  or one macOS runs from a translocated copy: "install by hand", with the reason.
- **Platform check**: `latest-*.json` carry a signed `"platform"`; a manifest for another platform is refused (`wrong-platform`), so a feed
  host cannot hand the Windows exe to a Linux app. `latest.json` has no `platform` field, because Windows builds from before this change
  reject unknown fields; absent means `win-x64`.
- Logs: `%APPDATA%\zotero-next-gpui\logs`, area `update`.

## latest.json (and latest-<platform>.json)

```json
{
  "version": "0.2.0+1a2b3c4d-20261201",
  "releasedAt": "2026-12-01T09:00:00Z",
  "notes": "# 0.2.0\n- ...markdown...",
  "url": "https://.../Zinc-Setup-0.2.0-1a2b3c4d-20261201.exe",
  "sha256": "<64 hex>",
  "size": 123456789,
  "minVersion": "0.1.0",
  "signature": "<base64 Ed25519>"
}
```

`minVersion` is optional: an older install cannot update in place and is told to install by hand.
`latest-linux-x64.json` and `latest-darwin-arm64.json` have the same fields plus `"platform": "linux-x64"` / `"darwin-arm64"`, and their
`url` is the AppImage / the `.app.zip`. Each manifest's `version` must be the stamp built into THAT package (`<file>.version`), or the
updated app sees the manifest as newer than itself and offers the same update again.
The signature is Ed25519 over the manifest without `signature`, as canonical JSON (keys sorted, no whitespace, UTF-8). Unknown fields are rejected.
Code: `core/src/update/` (`version.ts`, `manifest.ts`, `machine.ts` state machine, `updater.ts`, `env.ts` the real network/process side,
`platform.ts` which manifest a platform reads, `replace.ts` the Linux and macOS self-replacement).

## Keys

1. Generate once, **outside the repo**: `bun gpui-ui/scripts/release.ts --keygen C:\path\outside\repo\update-key`
   writes `release-key.private.json` (secret; back it up; losing it means shipping a new public key in a new build by hand) and `release-key.public.txt`.
2. Embed the public key at build time, one of: `ZN_UPDATE_PUBKEY=<base64>`, `ZN_UPDATE_PUBKEY_FILE=<path>`, or save it as `gpui-ui/update-pubkey.txt`
   (a public key is safe to commit). `scripts/_update-key.ts` reads it and `build.ts` bakes it into the exe. A build without a key never updates.
   A packaged exe cannot be pointed at another key by an environment variable.
3. The private key is only read by `release.ts` from `ZN_UPDATE_KEY`, which must not point inside the repo.
   The private key in `C:\Users\abora\zn-ws\_tmp\update\` is a throw-away TEST key; never ship with it.

## Where to host the feed

The repo `ABorakati/zinc` is private, so its release assets cannot be downloaded anonymously. Options:

1. **A public `zotero-next-releases` repo** (recommended): publish installer + `latest.json` as release assets there. Feed URL:
   `https://github.com/<owner>/zotero-next-releases/releases/latest/download/latest.json`. The installer URL in the manifest points at the same release.
   Only the installer and manifest are public; the source stays private. The installer is signed by the manifest, so a public host is fine.
2. **GitHub Pages** (or any static host): put `latest.json` on Pages and the installer wherever (release asset, Pages, S3).
3. **A token for the private repo** (not recommended for end users: a token that reads the repo would ship to every user). For your own machine:
   set `ZN_UPDATE_TOKEN` and use the API URL of the `latest.json` asset as the feed. The token is sent only to the feed's own origin.

Set the default feed at build time with `ZN_UPDATE_URL=<url>` (baked in), or per user in Settings > System > Updates > Update feed.

## Releasing

```
bun gpui-ui/scripts/package.ts --aot
bun gpui-ui/scripts/installer.ts
# Linux and macOS packages come from the "Desktop packages" workflow (or appimage.ts on Linux, dmg.ts on a Mac). Fetch them with their .version files:
gh release download <tag> --repo <owner>/zinc --pattern "Zinc-*" --dir dl
set ZN_UPDATE_KEY=C:\path\outside\repo\update-key\release-key.private.json
bun gpui-ui/scripts/release.ts --installer gpui-ui/out/installer/Zinc-Setup-<version>.exe --appimage dl/Zinc-<release>-x86_64.AppImage --mac-app dl/Zinc-<release>-arm64.app.zip --attach dl/Zinc-<release>-arm64.dmg --notes notes.md --publish <owner>/zotero-next-releases --dry-run
(then the same without --dry-run)
```

`release.ts` hashes each package, writes and signs one manifest per platform in `gpui-ui/out/release/` (`latest.json` for `--installer`,
`latest-linux-x64.json` for `--appimage`, `latest-darwin-arm64.json` for `--mac-app`), verifies its own output, refuses a key that does not
match the public key builds embed (`--force` overrides), and with `--publish` runs
`gh release create v<version> <packages> <manifests> <--attach files> --repo <owner>/<repo>`. Any one package alone works too.
The version of the installer comes from its file name; that of the AppImage and the zip from their `.version` file (`--version` overrides it for every package).
Without `--publish` it uploads nothing. The shipped build must embed the matching public key and be older than the release.
The private key never goes to CI: the workflow only builds the packages, embedding the repository variables `ZN_UPDATE_PUBKEY` and `ZN_UPDATE_URL`.

## Open points

- macOS self-update has unit tests (fakes for `ditto`, `codesign` and `open`; on Linux the helper script itself runs under `sh`), but it has
  not been run on a Mac. To check there: `codesign --verify` of a ditto-unpacked bundle, `open` of the swapped bundle, the toast flow.

- `gpui-ui/installer/zotero-next.iss` has no `/ZNRELAUNCH` yet: its `[Run]` entry is `skipifsilent`. Add an entry without `skipifsilent`,
  `Check: RelaunchRequested` (true when `CmdLineParamExists('/ZNRELAUNCH')`), so "Install now" restarts the app. Until then the update installs but the app does not restart by itself.
  `ZN_INSTALLER_ARGS` (JSON array) overrides the arguments without a rebuild.

## Tests and screenshots

- `cd core && bun test test/update` (unit tests + end-to-end against a local `Bun.serve` feed with a stub `.cmd` installer; `ZN_E2E_OUT=<dir>` keeps the evidence).
  `replace.test.ts` covers the Linux swap (real files in a temp folder) and the macOS steps; on Linux it also runs the relaunch waiter and the macOS helper script with `sh`.
- `cd gpui-ui && ZN_SHOTS=<dir> ZN_URL=http://127.0.0.1:1 bun scripts/shot-update.tsx [light]` (no network: a fake feed and key).
