# Releasing the browser extension

The Zinc Connector is the browser extension: it saves pages, and its library tab is the full Zinc app (WebAssembly). It lives in its own public repository, `ABorakati/zinc-connector` (a Zotero Connector fork). This page covers building its zips, what the CI workflow does, the update feed, and the manual steps to get automatic updates through the Chrome Web Store and Microsoft Edge Add-ons. The desktop installer and its update feed are in [Releasing](releasing.md).

**What updates itself and what does not.**

- A **store install** (Chrome Web Store, Edge Add-ons) is updated by the browser. You publish a new version to the store, by hand, and every install picks it up.
- An **unpacked install** (the zip from the website or a release, "Load unpacked") cannot update itself. The extension checks the signed feed `latest-extension.json` once a day and shows a notice in the save popup with a link to the new zip. The user unpacks it over the folder.
- **Automated upload to the stores from CI is not set up.** It needs a store API credential stored as a secret and is a decision for the project owner. Today every store release is a manual upload of the store zip.

## The two zips

One build gives two zips (`scripts/package.ts` in the connector repository):

| Zip | For | Manifest `key` |
| --- | --- | --- |
| `Zinc-Connector-<version>.zip` | unpacked installs, the website, the update feed | kept: the extension id is `pakgagonakcalfbmckaolkpidcojacaf` on every machine |
| `Zinc-Connector-<version>-store.zip` | upload to a store | removed: the stores refuse a `key` and assign their own id |

Both hold the same files: the extension, `library/` (library page, offscreen document, database worker, reader tab) and `updateKey.js`.

### Versions

The version comes from the tag: `v0.2.0` is `0.2.0`. Chrome allows 1 to 4 integers (0 to 65535) in `version`, so a pre-release gets a fourth integer and keeps its readable form in `version_name`:

| Tag | `version` | `version_name` | zip name |
| --- | --- | --- | --- |
| `v0.2.0` | `0.2.0` | (none) | `Zinc-Connector-0.2.0.zip` |
| `v0.2.0-beta.1` | `0.2.0.1` | `0.2.0-beta.1` | `Zinc-Connector-0.2.0-beta.1.zip` |

The text in the zip name is the same string in three places: `version_name` (or `version`) in the manifest, the `version` that `release.ts --extension-zip` writes into `latest-extension.json` (it parses the zip name), and what `browserExt/updateNotice.js` compares the feed with. Do not rename a zip. A pre-release sorts after its own release in a store (`0.2.0.1` is higher than `0.2.0`), so never upload a pre-release to a store once the release is out; stores get releases only.

## Building the zips locally

Needs the connector repository (branch `zotero-next`, with submodules and `bun install`) next to zotero-next, and zotero-next built (`reader-host/dist`, see [Building](building.md)).

```
# 1. the library page, in zotero-next
cd gpui-ui
bun web/build.ts --target extension --reader ../reader-host/dist      # writes gpui-ui/dist-extension

# 2. both zips, in the connector repository
cd ../../zinc-connector
bun scripts/package.ts --tag v0.2.0 --library ../zotero-next/gpui-ui/dist-extension --out dist
```

`package.ts` runs `scripts/build-win.ts` for you (`--skip-build` packs an existing `build/manifestv3`). The build needs the public key that verifies the update feed: it reads `gpui-ui/update-pubkey.txt` from `../zotero-next`, or `ZN_UPDATE_PUBKEY_FILE` / `ZN_UPDATE_PUBKEY`. Without one the build stops with a message (`ZN_ALLOW_NO_UPDATE_KEY=1` allows a local build with no update notice). The version mapping is unit tested: `bun test scripts/package.test.ts` in the connector repository.

## What the workflow does

`.github/workflows/extension.yml` (a Windows runner, the platform `build-win.ts` has been run on). `web.yml` builds the website's read-only demo of the app, not the extension; this workflow builds the extension.

- **When:** every push to `main` that touches `gpui-ui/`, `core/`, `connector-host/`, `reader-host/` or the workflow; a published release; and by hand (`workflow_dispatch`, optionally with `release_tag` for a release that already exists).
- **Steps:** checks out zotero-next and the connector (branch `zotero-next`, submodules) with the secret `CONNECTOR_REPO_TOKEN` when it is set, else the workflow's own token (the connector repository is public); installs Bun 1.4.4; fetches the vendored Zotero code (`core/vendor`, as `web.yml` does) and builds the Zotero reader and document worker into `reader-host/dist` (the reader repository is cloned at the commit pinned as `READER_COMMIT` in the workflow); builds the library page; packages the connector.
- **Every run** uploads the unpacked zip as the artifact `zinc-connector-unpacked` (kept 7 days). Its version is `0.0.0.<run number>` (`v0.0.0-ci.<run number>`).
- **A release** builds both zips with the version from the tag and attaches both to the release with `gh release upload`.
- It fails with a clear message if the connector checkout lacks `scripts/package.ts` or its submodules. Without `gpui-ui/update-pubkey.txt` it warns and builds zips that show no update notice, a release included (`ZN_ALLOW_NO_UPDATE_KEY=1`). The repository commits that file, and the workflow passes it to the build as `ZN_UPDATE_PUBKEY_FILE` only when it exists, so releases carry the key.

### The secret `CONNECTOR_REPO_TOKEN` (only for a private connector repository)

The connector repository is public, so the workflow checks it out with its own token and needs no secret. If the repository is made private again, the default workflow token cannot read it: create a **fine-grained personal access token** with the one repository `ABorakati/zinc-connector` and the single permission **Contents: read-only**, and save it as the Actions secret `CONNECTOR_REPO_TOKEN` in the zotero-next repository (Settings, Secrets and variables, Actions). Give it an expiry and put the renewal date in your calendar; when it expires the first step of the workflow fails and says so. Nothing in the workflow can write to the connector repository.

## The update feed for unpacked installs

After a release has its zips, sign the feed for the unpacked zip. The feed must point at the asset that is attached to the release (its SHA-256 is signed), so use the zip from the release, not a rebuild:

```
gh release download v0.2.0 --pattern "Zinc-Connector-0.2.0.zip"
set ZN_UPDATE_KEY=<path to release-key.private.json, outside the repository>
bun gpui-ui/scripts/release.ts --extension-zip Zinc-Connector-0.2.0.zip ^
    --extension-url https://github.com/ABorakati/zinc/releases/download/v0.2.0/Zinc-Connector-0.2.0.zip --out gpui-ui/out/release
gh release upload v0.2.0 gpui-ui/out/release/latest-extension.json
```

The feed's `version` is the connector's own version, parsed from the zip's file name, not the app's build stamp; `--extension-url` or `--base-url` sets the zip's address (without either, `--publish` implies the GitHub release asset URL). `release.ts --extension-zip` can also create the release itself (`--publish <owner/repo>`, see its header), uploading the zip and the feed together; then CI's zips are not the ones in the feed, so use one route or the other for a given tag. The extension reads `https://github.com/ABorakati/zinc/releases/latest/download/latest-extension.json` (`ZINC_UPDATE_FEED_URL` in `updateNotice.js`). Store installs do not use the feed: they have an `update_url` of the store's own and the notice does nothing for them. The key, signing and format are the desktop app's ([Updates](../user-guide/updates.md), `gpui-ui/UPDATES.md`).

## Automatic updates through the stores: the manual steps

Publish as an **unlisted** item on each store: it is not in search results, only people with the link can install it, and it still updates automatically. These steps are yours to do; nothing here is automated, and none of it has been done.

1. **Open the developer accounts.**
   - Chrome Web Store: a developer account (one-time registration fee of 5 US dollars) at the Chrome Web Store Developer Dashboard.
   - Microsoft Edge: a Microsoft Partner Center account, enrolled in the Microsoft Edge program (Edge Add-ons).
2. **Upload the store zip for the first time, by hand.** Take `Zinc-Connector-<version>-store.zip` (not the unpacked zip: it carries a `key` and the store refuses it) from the release. In each dashboard create a new item, upload the zip, fill in the listing and the privacy fields, and set the visibility to **Unlisted** (Chrome: Distribution, Visibility, Unlisted; Edge: Visibility, Hidden). Submit for review. The extension asks for broad permissions and a native-messaging host, so expect a review that asks for a justification of each.
3. **Read the item id.** Each store gives the item an id of its own: 32 letters a to p. Chrome shows it in the dashboard and in the item's address; Edge shows the Extension ID in Partner Center. It is different in each store and different from the pinned id `pakgagonakcalfbmckaolkpidcojacaf`. (Installed, the id is on `chrome://extensions` or `edge://extensions`.)
4. **Put the ids into the allowed-origins list.** The native-messaging host only talks to extensions on its list, which is one table at the top of `connector-host/install.ps1`:

   ```
   $KnownExtensionIds = [ordered]@{
     "unpacked"         = "pakgagonakcalfbmckaolkpidcojacaf"
     "chrome-web-store" = ""    # FILL IN
     "edge-addons"      = ""    # FILL IN
   }
   ```

   Fill the two empty slots (an empty slot is skipped). `gpui-ui/scripts/installer.ts` reads the `"unpacked"` line and checks it against the manifest key, so leave that line's format alone. `bun test connector-host/test/install-manifest.test.ts` checks the host manifest.
5. **Rebuild and reinstall the host.** Rebuild the installer (`bun gpui-ui/scripts/installer.ts`) and run it on every computer that uses the store version, or run `connector-host\install.ps1` there. Until then the store extension cannot reach the host: its save and library tab fail with a host-not-allowed error. (An id passed with `install.ps1 -ExtensionId a,b` replaces the list for that run.)
6. **Each later release.** Build the release (tag, CI, or locally), then upload `Zinc-Connector-<version>-store.zip` by hand to each store's dashboard as a new version of the same item and submit it. The manifest `version` must be higher than the last one uploaded. Browsers then update their installs, usually within a day or so after the review passes.

Whether to automate step 6 (the stores have publishing APIs, which need a credential kept as a secret) is open. It is not set up, and it needs your decision first.
