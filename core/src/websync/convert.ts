// Shape differences between zotero-next's stored JSON and the Zotero Web API.

import type { ZoteroJson } from "../sync/protocol";

/** Web API annotation item -> the reader JSON zotero-next stores (plus parentItem, which sync/apply.ts expects). */
export function annotationFromRemote(data: ZoteroJson): ZoteroJson {
	let position: unknown = data.annotationPosition;
	if (typeof position === "string") {
		try {
			position = JSON.parse(position);
		} catch {
			position = {};
		}
	}
	const out: ZoteroJson = {
		id: data.key,
		type: data.annotationType,
		color: data.annotationColor,
		sortIndex: data.annotationSortIndex,
		position: position ?? {},
		parentItem: data.parentItem,
		dateModified: data.dateModified,
		version: data.version,
		tags: Array.isArray(data.tags) ? data.tags : [],
	};
	if (typeof data.dateAdded === "string") out.dateAdded = data.dateAdded;
	if (typeof data.annotationText === "string") out.text = data.annotationText;
	if (typeof data.annotationComment === "string") out.comment = data.annotationComment;
	if (typeof data.annotationPageLabel === "string") out.pageLabel = data.annotationPageLabel;
	if (typeof data.annotationAuthorName === "string") out.authorName = data.annotationAuthorName;
	return out;
}

/** Reader annotation JSON (as in annotations.data, with parentItem) -> Web API annotation item. */
export function annotationToRemote(local: ZoteroJson, key: string, parent: string): ZoteroJson {
	const out: ZoteroJson = {
		key,
		itemType: "annotation",
		parentItem: parent,
		annotationType: local.type,
		annotationColor: local.color,
		annotationSortIndex: local.sortIndex,
		annotationPosition: typeof local.position === "string" ? local.position : JSON.stringify(local.position ?? {}),
		tags: Array.isArray(local.tags) ? local.tags : [],
		relations: {},
	};
	if (typeof local.text === "string") out.annotationText = local.text;
	if (typeof local.comment === "string") out.annotationComment = local.comment;
	if (typeof local.pageLabel === "string") out.annotationPageLabel = local.pageLabel;
	if (typeof local.authorName === "string") out.annotationAuthorName = local.authorName;
	if (typeof local.dateAdded === "string") out.dateAdded = local.dateAdded;
	if (typeof local.dateModified === "string") out.dateModified = local.dateModified;
	return out;
}
