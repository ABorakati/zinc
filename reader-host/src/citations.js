// Citation-popup actions for the reader host.
//
// Zotero's reader shows a popup (.citation-popup / .reference-popup, rows of .reference-row) when
// the pointer rests on an in-text citation or a bibliography entry. The reader exposes no hook for
// customising that popup (the only callback it passes through is onOpenLink, for URLs *inside* the
// text), so we add our action buttons by observing the reader's own React root for popups being
// rendered and appending a button row to each .reference-row. Nothing in vendor/reader is touched.
//
// Each row's text (plus any DOI in its links) is matched against GET /api/references/:attachmentKey
// (DOI exact, else title / author-year fuzzy match). Actions:
//   Open in library        -> parent.postMessage({type:'open-item', key})
//   Open in browser        -> POST /api/open-url
//   Add to library         -> POST /api/references/add (409 = already there)
//   Show in References     -> parent.postMessage({type:'show-references', index})
import { doiUrl, extractDoi, matchReference, referenceUrl } from "./match.ts";

const POPUP_SELECTOR = ".view-popup.citation-popup, .view-popup.reference-popup";
const ROW_SELECTOR = ".reference-row";
const MARK = "data-zn-actions";

const CSS = `
.zn-ref-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.zn-ref-actions button {
	font: inherit; font-size: 11px; line-height: 1.2; padding: 3px 8px; cursor: pointer;
	color: var(--fill-primary, inherit); background: var(--material-button, transparent);
	border: 1px solid var(--fill-quaternary, rgba(128,128,128,.4)); border-radius: 5px;
}
.zn-ref-actions button:hover:not(:disabled) { background: var(--fill-quinary, rgba(128,128,128,.15)); }
.zn-ref-actions button:disabled { opacity: .55; cursor: default; }
.zn-ref-actions button.zn-primary { color: var(--accent-blue, #0a84ff); border-color: currentColor; }
.zn-ref-actions .zn-status { font-size: 11px; opacity: .65; align-self: center; }
`;

export function installCitationActions({ attachment, postToParent, onError = console.warn }) {
	if (!attachment) return () => {};

	let style = document.createElement("style");
	style.textContent = CSS;
	document.head.appendChild(style);

	// ---- bibliography (resolved once, retried after failures) ----
	let referencesPromise = null;
	let failedAt = 0;
	function getReferences() {
		if (referencesPromise && (!failedAt || Date.now() - failedAt < 30000)) return referencesPromise;
		failedAt = 0;
		referencesPromise = fetch("/api/references/" + encodeURIComponent(attachment))
			.then((res) => {
				if (!res.ok) throw new Error("GET references -> " + res.status);
				return res.json();
			})
			.then((list) => list.references || [])
			.catch((e) => {
				failedAt = Date.now();
				onError("References unavailable for citation popups:", e);
				return [];
			});
		return referencesPromise;
	}

	async function postJSON(path, body) {
		let res = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let data = await res.json().catch(() => ({}));
		return { ok: res.ok, status: res.status, data };
	}

	function openUrl(url) {
		postJSON("/api/open-url", { url }).catch((e) => onError("open-url failed", e));
	}

	// ---- row enhancement ----
	function linkTargets(row) {
		return [...row.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "");
	}

	function button(label, title, onClick, primary) {
		let b = document.createElement("button");
		b.type = "button";
		b.textContent = label;
		if (title) b.title = title;
		if (primary) b.className = "zn-primary";
		// The popup lives over the PDF; keep clicks from reaching anything underneath.
		b.addEventListener("pointerdown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick(b);
		});
		return b;
	}

	function renderActions(box, state) {
		let { ref, doi, url } = state;
		box.textContent = "";
		if (state.loading) {
			let s = document.createElement("span");
			s.className = "zn-status";
			s.textContent = "Looking up…";
			box.appendChild(s);
			return;
		}
		if (ref?.inLibraryKey) {
			box.appendChild(
				button(
					"Open in library",
					"Show this item in your library",
					() => {
						postToParent({ type: "open-item", key: ref.inLibraryKey });
					},
					true,
				),
			);
			box.appendChild(
				button("Find Full Text", "Find and attach a PDF for this item", () => {
					postToParent({ type: "find-fulltext", keys: [ref.inLibraryKey] });
				}),
			);
		}
		if (url) {
			box.appendChild(button("Open in browser", url, () => openUrl(url)));
		}
		if ((ref || doi) && !ref?.inLibraryKey) {
			box.appendChild(
				button("Add to library", "Add this work to your library", async (b) => {
					b.disabled = true;
					b.textContent = "Adding…";
					try {
						let { ok, status, data } = await postJSON("/api/references/add", {
							doi: ref?.doi ?? doi,
							reference: ref || undefined,
						});
						let key = ok ? data?.data?.key : status === 409 ? data?.key : null;
						if (!key) throw new Error(data?.error || "status " + status);
						if (ref) ref.inLibraryKey = key; // cached list: later popups show it as in library
						postToParent({ type: "reference-added", key, index: ref?.index });
						renderActions(box, state);
					} catch (e) {
						onError("Add to library failed", e);
						b.disabled = false;
						b.textContent = "Add failed - retry";
					}
				}),
			);
		}
		if (ref) {
			box.appendChild(
				button("Show in References", "Show in the References panel", () => {
					postToParent({ type: "show-references", index: ref.index });
				}),
			);
		}
		if (!box.childElementCount) box.remove();
	}

	function enhanceRow(row) {
		if (row.querySelector(":scope > [" + MARK + "]")) return;
		let box = document.createElement("div");
		box.className = "zn-ref-actions";
		box.setAttribute(MARK, "");
		row.appendChild(box);

		// text without our own buttons (the box is empty/just created here)
		let text = row.textContent || "";
		let hrefs = linkTargets(row);
		let dois = hrefs
			.map((h) => {
				try {
					return extractDoi(decodeURIComponent(h));
				} catch {
					return extractDoi(h);
				}
			})
			.filter(Boolean);
		let doi = dois[0] || extractDoi(text);
		let httpLink = hrefs.find((h) => /^https?:\/\//i.test(h));
		let state = { loading: true, ref: null, doi, url: doi ? doiUrl(doi) : httpLink };
		renderActions(box, state);

		getReferences().then((refs) => {
			let ref = matchReference(refs, { text, dois });
			state = { loading: false, ref, doi: ref?.doi || doi, url: (ref && referenceUrl(ref)) || state.url };
			renderActions(box, state);
		});
	}

	function enhancePopup(popup) {
		for (let row of popup.querySelectorAll(ROW_SELECTOR)) enhanceRow(row);
	}

	// ---- observe only the reader UI root, and only react to popup subtrees ----
	let root = document.getElementById("reader-ui") || document.body;
	let pending = new Set();
	let scheduled = false;
	function flush() {
		scheduled = false;
		let popups = [...pending];
		pending.clear();
		for (let p of popups) if (p.isConnected) enhancePopup(p);
	}
	let observer = new MutationObserver((records) => {
		for (let rec of records) {
			for (let node of rec.addedNodes) {
				if (node.nodeType !== 1 || node.hasAttribute?.(MARK)) continue;
				if (node.matches(POPUP_SELECTOR)) pending.add(node);
				else {
					let owner = node.closest(POPUP_SELECTOR);
					if (owner) pending.add(owner);
					else for (let p of node.querySelectorAll(POPUP_SELECTOR)) pending.add(p);
				}
			}
		}
		if (pending.size && !scheduled) {
			scheduled = true;
			requestAnimationFrame(flush);
		}
	});
	observer.observe(root, { childList: true, subtree: true });
	for (let p of root.querySelectorAll(POPUP_SELECTOR)) enhancePopup(p);

	return () => {
		observer.disconnect();
		style.remove();
	};
}
