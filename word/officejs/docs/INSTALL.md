# Installing and Sideloading the Zinc Office.js Word Add-in

This guide covers building the task pane, trusting a local HTTPS certificate, sideloading `manifest/manifest.xml` into Word on Windows, macOS, and the web, and opening the task pane automatically with a document.

> **Prerequisite:** Use **Bun** only (`bun` and `bunx`). All commands below run from `word/officejs`.

---

## 1. Build the task pane and start the HTTPS dev server

1. Bundle the task pane into `word/officejs/dist/`:

   ```powershell
   cd word/officejs
   bun build.ts
   ```

   This writes `taskpane.html`, `main.js`, `style.css`, and the add-in icons (`icon-16.png`, `icon-32.png`, `icon-64.png`, `icon-80.png`) into `word/officejs/dist/`.

2. Start the local HTTPS server (listens on `127.0.0.1` and `::1`, port `44321` by default; override with `PORT`):

   ```powershell
   bun serve.ts
   ```

   Keep this server running while Word loads `https://localhost:44321/taskpane.html`. Every response carries `Cache-Control: no-store` so rebuilds appear on reload without clearing Word's WebView cache.

---

## 2. Create and trust the local HTTPS development certificate

Office refuses to load task panes over plain HTTP or untrusted self-signed certificates. `serve.ts` reads:

- `~/.office-addin-dev-certs/localhost.crt`
- `~/.office-addin-dev-certs/localhost.key`

### Recommended: `office-addin-dev-certs` via `bunx`

Run once per user account:

```powershell
bunx office-addin-dev-certs install
```

This generates `~/.office-addin-dev-certs/localhost.crt` and `localhost.key` (valid for `localhost` and `127.0.0.1`) and installs the local root CA into the OS certificate store (Windows CurrentUser `Root` store or macOS login Keychain) — accept the OS confirmation prompt when asked.

### Manual alternative (`openssl`)

If you prefer not to run `office-addin-dev-certs`, generate a certificate with Subject Alternative Names for `localhost`, `127.0.0.1`, and `::1`:

```bash
mkdir -p ~/.office-addin-dev-certs
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout ~/.office-addin-dev-certs/localhost.key \
  -out ~/.office-addin-dev-certs/localhost.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
```

Then trust `localhost.crt`:

- **Windows (PowerShell, current user):**
  ```powershell
  certutil -user -addstore Root "$HOME\.office-addin-dev-certs\localhost.crt"
  ```
- **macOS:**
  ```bash
  security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.office-addin-dev-certs/localhost.crt
  ```

Verify by opening `https://localhost:44321/taskpane.html` in Edge (Windows) or Safari (macOS) with `bun serve.ts` running and confirming there is no certificate warning.

---

## 3. Sideloading on Windows (Trusted Shared-Folder Catalog)

> **Why not the registry developer key?** Registering the manifest path under `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` **did not work on this machine** — Word ignores manifests placed solely under that registry key. Use a Trust Center **Trusted Add-in Catalog** (shared folder) instead.

1. **Create and share a catalog folder:**
   1. Create a folder such as `C:\Users\<you>\OfficeAddins` and copy `word/officejs/manifest/manifest.xml` into it.
   2. Right-click the `OfficeAddins` folder in File Explorer -> **Properties** -> **Sharing** -> **Share…**.
   3. Share it with your own Windows user account (**Read** permission is enough) and note the network path shown, e.g. `\\<computer>\OfficeAddins` (you can check your machine name with `$env:COMPUTERNAME`).

2. **Add the shared folder in Word's Trust Center:**
   1. In Word, open **File > Options > Trust Center > Trust Center Settings… > Trusted Add-in Catalogs**.
   2. In **Catalog Url**, enter the UNC path `\\<computer>\OfficeAddins` and click **Add catalog**.
   3. Tick **Show in Menu** on the newly added row, click **OK**, and **restart Word**.

3. **Load Zinc in a document:**
   1. Open a document in Word (with `bun serve.ts` running).
   2. Go to **Home > Add-ins > More Add-ins** (or **Insert > Get Add-ins / My Add-ins**) -> **Shared Folder**.
   3. Select **Zinc** and click **Add**. A **Zinc** button appears on the **Home** tab under **Citations**.

---

## 4. Sideloading on macOS (`wef` folder)

Word for Mac automatically discovers XML manifests placed inside its sandboxed `wef` folder:

1. Create the directory if it does not exist and copy `manifest/manifest.xml` into it:

   ```bash
   mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
   cp word/officejs/manifest/manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/manifest.xml
   ```

2. Quit and reopen **Microsoft Word** (with `bun serve.ts` running).
3. Open a document, click **Home > Add-ins** (or **Insert > Add-ins > My Add-ins**), and choose **Zinc** from the developer add-ins section at the top of the menu.

---

## 5. Sideloading in Word on the web

1. Make sure `bun serve.ts` is running locally and your browser trusts `https://localhost:44321/taskpane.html` (visit that URL in another tab first if needed, and allow localhost requests if your browser prompts for local network access).
2. Open a document in **Word on the web** (OneDrive or SharePoint).
3. Select **Home > Add-ins > More Add-ins** (or **Insert > Add-ins**).
4. Switch to the **MY ADD-INS** tab, click **Manage My Add-ins** (top-right corner) -> **Upload My Add-in**, choose `word/officejs/manifest/manifest.xml`, and click **Upload**.
5. Click the **Zinc** button on the **Home** tab to open the task pane.

---

## 6. Opening the task pane automatically (`Office.AutoShowTaskpaneWithDocument`)

Office can open the Zinc task pane automatically whenever a specific `.docx` file is opened. This uses two pieces working together:

1. **Manifest declaration (already configured):** In `manifest/manifest.xml`, the ribbon button's `ShowTaskpane` action declares the reserved task-pane ID:

   ```xml
   <Action xsi:type="ShowTaskpane">
       <TaskpaneId>Office.AutoShowTaskpaneWithDocument</TaskpaneId>
       <SourceLocation resid="Zinc.Taskpane.Url" />
   </Action>
   ```

   Only one `ShowTaskpane` action in a manifest may carry `Office.AutoShowTaskpaneWithDocument`.

2. **Per-document setting:** Word only auto-opens the pane for documents that have opted in via `Office.context.document.settings`. Inside the task pane (or from DevTools console while the pane is open in that document), run:

   ```ts
   Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
   Office.context.document.settings.saveAsync();
   ```

   Save the document afterwards so the setting is persisted in the `.docx` package. Reopening that document in Word (once Zinc is sideloaded) opens the task pane automatically.

   To stop auto-opening the pane for a document:

   ```ts
   Office.context.document.settings.remove("Office.AutoShowTaskpaneWithDocument");
   Office.context.document.settings.saveAsync();
   ```
