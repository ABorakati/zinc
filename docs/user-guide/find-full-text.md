# Find Full Text

Find Full Text looks for a PDF of an item and attaches it. It tries open-access sources first and, if you have set up an institution, your library's subscription access afterwards. The search is done by the **zotero-fulltext** engine (`ABorakati/zotero-fulltext`), a WebAssembly module that the app runs for every lookup; the app supplies the network access, the sign-in and the storage.

## Running it

| From | How |
|---|---|
| Item list | Select one or more items, right-click, and choose **Find Full Text**, or **Find Full Text (open access only)**. |
| Item pane | The **Find full text** button in the header, shown when the item has no PDF. When it already has one, **Find full text again** is in the header's **⋯** menu. |
| Automatically | **Settings > General > Adding items > Automatically attach associated PDFs when adding items** runs it on items you add by identifier or from a URL (the setting's own description also mentions importing). |

The menu entries apply to regular items (not attachments, notes or annotations) and are hidden in the Trash.

**Find Full Text (open access only)** skips institutional routes for that run, whatever your settings say.

## The progress panel

A **Find Full Text** panel appears at the bottom-right of the window. Each run is a block with a progress bar and **Cancel** while it is running, and one row per item showing its state and the source it used:

| State | Meaning |
|---|---|
| Waiting, Searching, Downloading | In progress. |
| PDF attached | A PDF was found and added to the item. |
| Already has a PDF | The item needed nothing. |
| Sign-in needed | The only route found needs your institution's subscription. |
| Not found | No source had a PDF. |
| Failed, Cancelled | The lookup failed (with a message) or you cancelled it. |

Collapse the panel with its header; if it is collapsed, a short message appears when a run finishes. **Clear** removes finished runs.

Several items are fetched at once. The number is set in **Settings > Find Full Text > Items fetched at once** (1 to 8). More is faster but harder on publishers' sites.

## Institutional access

Open-access sources need no set-up, except Unpaywall, which asks for an email address. To use your institution's subscriptions:

1. Open **Settings > Find Full Text**, or **Tools > Find Full Text Settings…**, or the gear in the progress panel.
2. Under **Institution**, click **Change…**. In the dialog, search by name under **Find your institution** and click a result. The dialog shows which sign-in methods it knows for it: **OpenAthens**, **Shibboleth / UK federation**, or **Library proxy**. If your institution is not listed, fill in the fields yourself: **Institution name**, **OpenAthens domain**, **Shibboleth entityID** and **Library proxy address**. Add at least one method.
3. Choose **How to sign in**: **Automatic**, **In a window here**, or **Link for my own browser**.
4. Make sure **Use institutional access** is on (off means open access only), and click **Save**. **Use the built-in default** restores the default institution.

The other Find Full Text settings:

| Setting | Notes |
|---|---|
| **Use institutional access** | Off: open-access sources only. |
| **Unpaywall email** | Sent to Unpaywall with each lookup, as their terms ask. It stays on your computer; leave it empty and Unpaywall is not used. |
| **Items fetched at once** | 1 to 8. |

### Signing in

Institution sign-in uses **a sign-in window in the app**. **Sign in to Institution…** (in the **Tools** menu, and in the progress panel as **Sign in to** your institution) opens it. Items that ended as "Sign-in needed" can be retried from the panel after you sign in, one by one with **Sign in**, or together with a single "sign in and retry" link.

The sign-in window is an ordinary resizable window. Its title shows the real address of the page (with "(not secure)" for a plain-http page), and a bar at the bottom says what it is signing in for, with **Keep waiting**, **Open in browser** and **Skip**. Close the window to cancel. Your institution's own sign-in page appears in it the first time, and again only when that sign-in expires; the session is kept between runs. A PDF is captured whether the publisher downloads it or shows it in the browser's viewer.

- The sign-in browser keeps its own profile in `%APPDATA%\zotero-next-signin.exe\EBWebView`, separate from the notes and web tabs. On first use, a sign-in from the older Electrobun build of Zotero Next is copied into it once, so you normally do not have to sign in again.
- Cookies are never written to the app's logs; logs record only the host and path of each page.
- With **Link for my own browser** (or `ZN_SIGNIN=0`, or outside Windows) there is no window: items end with an **Open** button, which opens the publisher link in your own browser, where you can sign in and download the PDF yourself, then run Find Full Text again.

A few other outcomes are reported with a message: you closed the window, the sign-in timed out, or your institution's access policy refused it.

## Retrieve Metadata is separate

Find Full Text starts from an item and finds a PDF. The opposite, starting from a PDF and finding the item, is **Retrieve Metadata for PDF**; see [Adding items](adding-items.md#retrieve-metadata-for-pdf).

See [Troubleshooting](troubleshooting.md) if lookups fail, and [Logs and reports](logs-and-reports.md) for the app's logs.
