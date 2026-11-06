# Zotero Next installer

`bun gpui-ui/scripts/installer.ts` builds `gpui-ui/out/installer/ZoteroNext-Setup-<version>.exe` (and a `.json` with version, size and
sha256) from the packaged AOT folder (`bun gpui-ui/scripts/package.ts --aot`). It does not rebuild the package.

Tool: Inno Setup 7 (`zotero-next.iss`). Found via `ZN_ISCC`, `C:/Users/abora/zn-ws/_tmp/installer/inno/ISCC.exe`,
`%LOCALAPPDATA%\Programs\Inno Setup 7`, Program Files or PATH. To get it without admin: download `innosetup-7.1.1-x64.exe` from
https://github.com/jrsoftware/issrc/releases and run it with `/VERYSILENT /CURRENTUSER /PORTABLE=1 /NOICONS /DIR=<folder>`.

## What it does

- Per user, no admin: `%LOCALAPPDATA%\Programs\Zotero Next`; Start-menu shortcut (app icon); optional desktop shortcut; Apps & features
  entry under HKCU (publisher, version = the full build stamp, icon, size, uninstall and quiet-uninstall commands).
- Optional component "Word add-in", ticked by default: the add-in (built by `word/build.ps1 -OutDir`, never into `word/dist`) is copied to
  `<app>\word\addin` and registered per user by the bundled `install.ps1` (HKCU only); the uninstaller runs `uninstall.ps1` first.
- Upgrade in place: same AppId, files replaced, folders the installer owns are cleared first so removed files do not linger. The
  component choice is remembered.
- Running app (`zotero-next-gpui.exe` from the install folder) and running Word are detected. Interactive: asked to close (the app is
  closed for you on OK). Silent: the app is closed gracefully (WM_CLOSE, 15 s) or the install fails; if Word is open the add-in is left as it is.
- Never touched: `%APPDATA%\zotero-next*`, the library, logs, settings. Uninstall removes program files and registry entries only. It
  asks "Also remove settings and logs?" (default No); that removes `%APPDATA%\zotero-next-gpui` (but never `*.sqlite*`/`*.db` files) and
  the web tabs' WebView2 profile, plus the Word add-in's own data folders. A library is never removed.

## Command lines

```
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART                       silent install or upgrade (what the updater runs)
Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ZNRELAUNCH           ... and start the app afterwards
Setup.exe ... /COMPONENTS="app" | "app,word"   /TASKS="desktopicon"   /DIR="..."   /LOG="file"
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
