# Releasing

How a build becomes an installer, and how an installer becomes an update that installed copies pick up. Building each piece is covered in [Building](building.md); the user-facing side of updates is in [Updates](../user-guide/updates.md).

## Overview

```
bun gpui-ui/scripts/package.ts --aot       # gpui-ui/out/package-aot/zotero-next-gpui/
bun gpui-ui/scripts/installer.ts           # gpui-ui/out/installer/ZoteroNext-Setup-<version>.exe
bun gpui-ui/scripts/release.ts --installer <that exe> --notes <file> ...   # signs latest.json, optionally publishes
```

`installer.ts` does not rebuild the package, and `release.ts` does not build anything: it hashes the installer you give it, writes a signed manifest, and optionally uploads. The build that users run must already contain the matching public key (below) and be older than the release.

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

`bun gpui-ui/scripts/installer.ts` writes `gpui-ui/out/installer/ZoteroNext-Setup-<version>.exe` (the `+` in the stamp becomes `-`) and `ZoteroNext-Setup-<version>.json` with the version, size and SHA-256. It uses Inno Setup 7 and `gpui-ui/installer/zotero-next.iss`. Options and how Inno Setup is found are in [Building](building.md). In short, it is a per-user install with no admin rights into `%LOCALAPPDATA%\Programs\Zotero Next`, with optional components for the Word add-in and the browser connector, and it upgrades in place (same AppId). It never touches the library, logs or settings; the uninstaller asks before removing settings and logs.

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
   - `gpui-ui/update-pubkey.txt`, which may be committed because a public key is not secret.

   `build.ts` bakes the key into the executable. A build with no key prints a warning, cannot verify any manifest and never updates. A packaged executable cannot be pointed at another key by an environment variable.

3. The private key is read only by `release.ts`, from the path in `ZN_UPDATE_KEY`. The script refuses a path inside the repository.

The default feed URL is baked in at build time with `ZN_UPDATE_URL=<https url of latest.json>`; a user can override it in Settings under System, Updates. With no feed URL nothing is ever requested.

## `release.ts`

```
ZN_UPDATE_KEY=<path to release-key.private.json> \
bun gpui-ui/scripts/release.ts --installer <ZoteroNext-Setup-....exe> [options]
```

| Option | Meaning |
| --- | --- |
| `--version <stamp>` | Default: parsed from the installer's file name, else the package's `version.txt` |
| `--notes <file or text>` | Release notes, Markdown (default `Zotero Next <version>`) |
| `--url <https url>` | Where users download the installer (required unless `--publish`, which implies the GitHub release asset URL) |
| `--min-version <v>` | Older installs cannot update in place and are told to install by hand |
| `--out <dir>` | Where `latest.json` goes (default `gpui-ui/out/release`) |
| `--publish <owner/repo>` | Run `gh release create` on that repository with the installer and `latest.json` |
| `--tag <tag>` | Release tag (default `v<version>`) |
| `--dry-run` | With `--publish`: print the `gh` command instead of running it |
| `--force` | Skip the check that the key matches the public key builds embed |

It hashes the installer, signs the manifest, verifies its own output, and refuses a private key that does not match the public key builds embed. Without `--publish` it uploads nothing. Always preview first:

```
bun gpui-ui/scripts/release.ts --installer <setup.exe> --notes notes.md --publish <owner>/<releases-repo> --dry-run
```

With `--publish` it runs `gh release create <tag> <installer> <latest.json> --repo <owner>/<repo> --title "Zotero Next <version>" --notes-file <notes> --latest`, so `gh` must be installed and logged in. Publishing is a deliberate act; do not run it from automation without a human decision.

## `latest.json`

```json
{
  "version": "0.2.0+1a2b3c4d-20261201",
  "releasedAt": "2026-12-01T09:00:00Z",
  "notes": "# 0.2.0\n- ...markdown...",
  "url": "https://<host>/<path>/ZoteroNext-Setup-0.2.0-1a2b3c4d-20261201.exe",
  "sha256": "<64 hex characters>",
  "size": 123456789,
  "minVersion": "0.1.0",
  "signature": "<base64 Ed25519>"
}
```

`minVersion` is optional. The signature is Ed25519 over the manifest without `signature`, as canonical JSON: object keys sorted, no whitespace, UTF-8. Every other field is signed, so changing the URL, hash, size, version or notes invalidates it. Unknown fields are rejected. The code is `core/src/update/manifest.ts`.

## The feed and the update flow

The feed is `latest.json` at an https URL (plain http is accepted for localhost only, for tests). It must be fetchable by the installed apps without credentials, so the hosting choice matters:

- If the source repository is private, its release assets cannot be downloaded anonymously. Publish the installer and `latest.json` somewhere users can reach, for example a separate public releases repository (then only the installer and manifest are public). The signature on the manifest, not the host, protects users.
- For your own machine only, `ZN_UPDATE_TOKEN` (a GitHub token) is sent as a bearer token to the feed's own origin and nowhere else. Do not ship a token to users.

What the app does (`core/src/update/`, `gpui-ui/src/update/`):

- It checks about 20 seconds after the first items load, then every 24 hours, if "Check automatically" is on (default). "Download automatically" is off by default. "Check now" always works.
- It downloads to `%LOCALAPPDATA%\zotero-next-gpui\updates\zotero-next-<version>-setup.exe`, resumable. Size and SHA-256 must match the signed manifest or the file is deleted; it is verified again right before running.
- "Install now" closes the database cleanly, starts the installer detached with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH` and exits. "Install on exit" does the same at the next normal quit, without `/ZNRELAUNCH`. A crash exit installs nothing. `ZN_INSTALLER_ARGS` (a JSON array, with `{pid}` and `{file}` placeholders) overrides the arguments.
- Logs go to `%APPDATA%\zotero-next-gpui\logs`, area `update`.

## Release checklist

1. Check `main` is green in CI and run the checks in [Testing](testing.md).
2. Decide the release number (`ZN_RELEASE`) and build with `bun gpui-ui/scripts/package.ts --aot` using a build environment that has the update public key and `ZN_UPDATE_URL` set.
3. Build the installer with `bun gpui-ui/scripts/installer.ts`. Install it on a clean machine or in a sandbox (`--test`) and check a silent upgrade over the previous version.
4. Run `release.ts` with `--dry-run`, read the command, then publish.
5. Check that an installed older build offers the update and installs it.

The repository is private and this documentation is not published anywhere; no step above publishes documentation.
