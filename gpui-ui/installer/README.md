# Zinc installer

`bun gpui-ui/scripts/installer.ts` builds `gpui-ui/out/installer/Zinc-Setup-<version>.exe` (and a `.json` with version, size and
sha256) from the packaged AOT folder (`bun gpui-ui/scripts/package.ts --aot`). It does not rebuild the package.

Tool: Inno Setup 7 (`zotero-next.iss`). Found via `ZN_ISCC`, `C:/Users/abora/zn-ws/_tmp/installer/inno/ISCC.exe`,
`%LOCALAPPDATA%\Programs\Inno Setup 7`, Program Files or PATH. To get it without admin: download `innosetup-7.1.1-x64.exe` from
https://github.com/jrsoftware/issrc/releases and run it with `/VERYSILENT /CURRENTUSER /PORTABLE=1 /NOICONS /DIR=<folder>`.

## What it does

- Per user, no admin: `%LOCALAPPDATA%\Programs\Zinc`; Start-menu shortcut (app icon); optional desktop shortcut; Apps & features
  entry under HKCU (publisher, version = the full build stamp, icon, size, uninstall and quiet-uninstall commands).
- Optional component "Word add-in", ticked by default: the add-in (built by `word/build.ps1 -OutDir`, never into `word/dist`) is copied to
  `<app>\word\addin` and registered per user by the bundled `install.ps1` (HKCU only); the uninstaller runs `uninstall.ps1` first.
- Optional component "Browser connector (save from Chrome/Edge without the app open)", ticked by default: see the next section.
- Upgrade in place: same AppId, files replaced, folders the installer owns are cleared first so removed files do not linger. The
  component choice is remembered.
- Running app (`zotero-next-gpui.exe` from the install folder) and running Word are detected. Interactive: asked to close (the app is
  closed for you on OK). Silent: the app is closed gracefully (WM_CLOSE, 15 s) or the install fails; if Word is open the add-in is left as it is.
- Never touched: `%APPDATA%\zotero-next*`, the library, logs, settings. Uninstall removes program files and registry entries only. It
  asks "Also remove settings and logs?" (default No); that removes `%APPDATA%\zotero-next-gpui` (but never `*.sqlite*`/`*.db` files) and
  the web tabs' WebView2 profile, plus the Word add-in's own data folders. A library is never removed.

## Browser connector

Two ways to save from the browser into the library:

- **Zinc Connector** (this component): a fork of the Zotero Connector (`C:\Users\abora\zotero-next-connector`, branch
  `zotero-next`) that talks to `zotero-next-host.exe` over Chrome native messaging. Saves go straight into the library database, **with
  the app closed**. Works in Chrome and Edge.
- **The official Zotero Connector** from the Chrome Web Store or the Edge Add-ons store: needs nothing from this installer, but only works
  **while Zinc is open**, because the app itself answers on Zotero's connector port 23119 (the Zotero-compatible server; the
  app's own API is on 23120). Install only one of the two connectors per browser, or pages show two Save buttons.

What the component installs, in `<app>\connector`:

| File | Purpose |
| --- | --- |
| `zotero-next-host.exe`, `install.ps1`, `uninstall.ps1` | the native-messaging host and the scripts from `connector-host/` |
| `com.zotero_next.connector_host.json` | the host manifest, written at install time: `path` = the installed exe, `allowed_origins` = the extension id |
| `extension\` | the built Chrome MV3 extension (unpacked), id `pakgagonakcalfbmckaolkpidcojacaf` (pinned by the manifest `key`) |
| `connector-howto.html` | the page the finish screen and the Start-menu shortcut "Zinc Connector - how to install" open |

Registration is per user (HKCU, no admin) and done by the bundled `install.ps1 -ManifestDir <app>\connector -HostExe <app>\connector\zotero-next-host.exe`
under 64-bit Windows PowerShell, like the Word add-in: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.zotero_next.connector_host` and the
same under `Microsoft\Edge`, default value = the manifest path. I reused the script rather than writing the keys with `[Registry]` entries
because there is then one writer of the manifest (JSON, escaping), the same code serves install, re-register after an upgrade or a changed
folder, and the unregister on "component unticked on upgrade" and on uninstall (Inno's own `[Registry]` cleanup does not cover an unticked component).

**Loading the extension is a manual step.** Chrome and Edge do not let an installer add an unpacked extension. The finish page offers "Show how to
add the browser extension" (silent installs skip it), and the Start menu has the same page: `chrome://extensions` -> Developer mode -> Load unpacked ->
`<app>\connector\extension` (the page shows and copies the exact folder). Keep the folder: the browser loads from it at every start. After an
upgrade, click reload on the extension card. The extension id stays the same on every machine, so the registration never needs changing.

**Locked exe on upgrade/uninstall.** The browser starts the host and keeps it while it runs, so the exe is locked. Setup ends any
`zotero-next-host.exe` that runs from `<app>\connector` before it replaces or removes files (also in silent runs, also in the uninstaller). That
is safe by design: each library write is a short transaction, in-flight save sessions are kept on disk, and the extension starts a new host on its
next call (a save that was mid-flight at that moment fails and can be repeated). Hosts from elsewhere (the `connector-host\dist` dev build) are left alone.

The uninstaller runs `uninstall.ps1` first (removes both registry keys and the manifest), then deletes `<app>\connector` including anything the browser
wrote into the extension folder. If the component is unticked on an upgrade, the same happens. The extension itself stays in the browser until
you remove it on the extensions page. `installer.ts` builds the host straight into `out/installer/connector-stage` (not `connector-host/dist`, which
a running browser may hold), runs the fork's Bun build (`bun run build` in `zotero-next-connector`, no Node/npm), checks that the manifest `key`
yields the id `install.ps1` allows, and stages the lot without Chrome's `_metadata` folder. `ZN_CONNECTOR_DIR` points at the fork if it is not next to
this repo; `--no-connector` builds an installer without the component; `--reuse-connector` reuses the staged build.

Test installers register the host name `com.zotero_next.connector_host_test` instead, so they never replace or remove a real registration.

## Command lines

```
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART                       silent install or upgrade (what the updater runs)
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH           ... and start the app afterwards
Setup.exe ... /COMPONENTS="app" | "app,word" | "app,word,connector"   /TASKS="desktopicon"   /DIR="..."   /LOG="file"
unins000.exe /VERYSILENT /SUPPRESSMSGBOXES [/REMOVEDATA]                 silent uninstall (/REMOVEDATA also removes settings and logs)
```
Test hooks: `/ZNTESTHIVE="file"` registers the add-in into a private registry hive instead of HKCU; `/ZNAPPDATA="dir"` redirects the
"remove settings" step. `scripts/installer.ts --test` builds an installer with its own AppId and name for sandbox runs.

## Code signing (`scripts/sign.ts`)

Nothing is signed until a certificate is configured ("unsigned: no certificate configured" is printed). Configure by environment:

| Variables | Signs with |
| --- | --- |
| `ZN_SIGN_PFX`, `ZN_SIGN_PFX_PASSWORD` | `signtool` (Windows SDK, found under `C:\Program Files (x86)\Windows Kits\10\bin`) |
| `ZN_SIGN_AZURE_ENDPOINT`, `ZN_SIGN_AZURE_ACCOUNT`, `ZN_SIGN_AZURE_PROFILE` | Microsoft's `sign` tool (`dotnet tool install --global sign --prerelease`) with Azure Artifact Signing (formerly Trusted Signing); log in with `az login` or use a managed identity (`ZN_SIGN_AZURE_CREDENTIAL`) |

Optional: `ZN_SIGN_TIMESTAMP` (default Microsoft's server for Azure, DigiCert's for a pfx; `none` to skip), `ZN_SIGN_TOOL`,
`ZN_SIGN_DESCRIPTION`, `ZN_PUBLISHER` (installer publisher name, default "Aditya Borakati"; should match the certificate subject).
`package.ts` signs the exe and `zn_pdf.dll`; `installer.ts` signs the add-in dll, and the setup and uninstaller through Inno's SignTool hook.
`bun gpui-ui/scripts/sign.ts --check <file>` reports whether a file carries a signature.

### Buying a certificate

- **Azure Artifact Signing (Trusted Signing)**: about $10 a month, no hardware token, short-lived certificates managed by Microsoft,
  identity validation required (individuals and organisations in supported countries). Easiest and cheapest; SmartScreen reputation
  builds quickly. Needs an Azure subscription.
- **OV code-signing certificate** (DigiCert, Sectigo, SSL.com ...): roughly $200 to $400 a year, private key on a hardware token or
  cloud HSM since 2023. SmartScreen reputation builds slowly with downloads.
- **EV code-signing certificate**: roughly $300 to $600 a year, hardware token, immediate SmartScreen reputation for the publisher.

Whichever you pick, set the variables above; no other change is needed.
