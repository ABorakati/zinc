// Files and folders > the ZotMoov rows: what happens to files placed in the attachment storage folder (automatic or manual, move or
// copy, which types, naming, tag, delete with the item) and "attach newest file from" a folder. Server side: core/src/files/{storage,organize}.ts.
// The folder itself, the subfolder pattern and "move existing attachments" are in defs/files.tsx (the "Attachment storage location" row).
import { Show, type JSX } from "solid-js";
import { formatExtensions, parseExtensions } from "../../features/storage/summary";
import type { StorageInfo } from "../../features/storage/state";
import { revealInFolder } from "../../shell/native";
import { Btn, Segmented, TextField, Toggle, Value } from "../controls";
import { registerSettings } from "../registry";
import { Col, files, gone, PathText, pick, putStorage, Row } from "./files";

type Flag = "auto" | "rename" | "renameTitle" | "addTag" | "deleteFiles" | "pruneEmptyDirs" | "stripDiacritics" | "attachConfirm";

/** The control, or a hint while no storage folder is chosen (these settings only matter once there is one). */
function NeedsFolder(p: { children: (s: StorageInfo) => JSX.Element }): JSX.Element {
	return (
		<Show when={files.view()} fallback={gone()}>
			{(v) => (
				<Show when={v().storage.dir} fallback={<Value>Choose a storage folder first.</Value>}>
					{p.children(v().storage)}
				</Show>
			)}
		</Show>
	);
}

const Flagged = (p: { s: StorageInfo; k: Flag; label?: string }): JSX.Element => (
	<Row>
		<Toggle checked={p.s[p.k]} onChange={(v) => void putStorage({ [p.k]: v })} />
		<Show when={p.label}>
			<PathText sub>{p.label!}</PathText>
		</Show>
	</Row>
);

registerSettings([
	{
		id: "files.storageAuto",
		section: "files",
		label: "Place new files in the storage folder automatically",
		description:
			"Files you add, save from the browser, import or fetch with Find Full Text go straight to the storage folder. Off: only the Attachment Files commands in the item menu use it. Files that arrive by sync are never moved.",
		keywords: ["zotmoov", "automatic", "automove", "auto move", "storage folder", "new files"],
		control: () => <NeedsFolder>{(s) => <Toggle checked={s.auto} onChange={(auto) => void putStorage({ auto })} />}</NeedsFolder>,
	},
	{
		id: "files.storageBehavior",
		section: "files",
		label: "Move or copy",
		description:
			"Move: the file lives in the storage folder (as a linked file or, below the location row, an imported one). Copy: it stays in the library's own storage and a copy is also placed in the storage folder.",
		keywords: ["zotmoov", "file behavior", "move", "copy"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<Segmented<"move" | "copy">
						value={s.behavior}
						onChange={(behavior) => void putStorage({ behavior })}
						options={[
							{ value: "move", label: "Move" },
							{ value: "copy", label: "Copy" },
						]}
					/>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.storageTypes",
		section: "files",
		label: "File types to handle",
		layout: "block",
		description:
			"Only these extensions go to the storage folder (others stay in the library's own storage), e.g. pdf, epub, docx, djvu. Empty: every file type.",
		keywords: ["zotmoov", "allowed file extensions", "extensions", "pdf", "epub", "file types"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<TextField
						value={formatExtensions(s.allowedExt)}
						width={300}
						placeholder="pdf, epub, docx, djvu"
						onCommit={(v) => void putStorage({ allowedExt: parseExtensions(v) })}
					/>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.storageRename",
		section: "files",
		label: "Name files from their item",
		layout: "block",
		description:
			"A file placed in the storage folder is named Author - Year - Title.ext from its parent item. The attachment's title can follow the new file name (ZotMoov's default).",
		keywords: ["zotmoov", "rename", "rename title", "file name", "author year title"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<Col gap={6}>
						<Flagged
							s={s}
							k="rename"
							label={s.rename ? "Rename files when they are placed in the storage folder." : "Keep the original file names."}
						/>
						<Show when={s.rename}>
							<Flagged s={s} k="renameTitle" label="The attachment title becomes the new file name." />
						</Show>
					</Col>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.storageTag",
		section: "files",
		label: "Tag files in the storage folder",
		layout: "block",
		description:
			"Attachments placed in the storage folder get this tag, so they are easy to find; converting one back to a stored file removes it.",
		keywords: ["zotmoov", "tag", "add zotmoov tag"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<Col gap={6}>
						<Flagged s={s} k="addTag" />
						<Show when={s.addTag}>
							<TextField value={s.tag} width={200} onCommit={(tag) => tag.trim() && void putStorage({ tag })} />
						</Show>
					</Col>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.storageNames",
		section: "files",
		label: "Folder and file names",
		layout: "block",
		description:
			"Strip diacritics from names and folders (é becomes e); and the text the {%U} wildcard stands for in subfolder patterns.",
		keywords: ["zotmoov", "diacritics", "accents", "undefined", "wildcard"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<Col gap={6}>
						<Flagged s={s} k="stripDiacritics" label="Strip diacritics from names and folders." />
						<TextField
							value={s.undefinedStr}
							width={200}
							placeholder="undefined"
							onCommit={(undefinedStr) => undefinedStr.trim() && void putStorage({ undefinedStr })}
						/>
					</Col>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.storageDelete",
		section: "files",
		label: "Delete files with their items",
		layout: "block",
		description:
			"When a linked attachment in the storage folder is deleted permanently (Delete Permanently, Empty Trash), its file is deleted too, unless another attachment uses it. Items deleted by sync never delete files.",
		keywords: ["zotmoov", "delete files", "prune empty directories", "empty folders", "trash"],
		control: () => (
			<NeedsFolder>
				{(s) => (
					<Col gap={6}>
						<Flagged
							s={s}
							k="deleteFiles"
							label={s.deleteFiles ? "Files are deleted with their items." : "Files stay when their items are deleted."}
						/>
						<Flagged s={s} k="pruneEmptyDirs" label="Remove folders that become empty." />
					</Col>
				)}
			</NeedsFolder>
		),
	},
	{
		id: "files.attachDir",
		section: "files",
		label: "Attach newest file from",
		layout: "block",
		description:
			"The item menu's Attach Newest File command takes the most recently saved file of this folder (for example Downloads), attaches it to the item and removes it from the folder once the copy is verified.",
		keywords: ["zotmoov", "attach new file", "downloads", "search folder", "newest file", "last modified"],
		control: () => (
			<Show when={files.view()} fallback={gone()}>
				{(v) => (
					<Col>
						<Row>
							<PathText>{v().storage.attachDir ?? "No folder chosen"}</PathText>
							<Btn onClick={() => void pick((p) => putStorage({ attachDir: p }))}>Choose folder…</Btn>
							<Show when={v().storage.attachDir}>
								<Btn onClick={() => revealInFolder(v().storage.attachDir!)}>Show in folder</Btn>
								<Btn onClick={() => void putStorage({ attachDir: null })}>Clear</Btn>
							</Show>
						</Row>
						<Show when={v().storage.attachDir}>
							<Flagged s={v().storage} k="attachConfirm" label="Ask for the file name before attaching." />
						</Show>
					</Col>
				)}
			</Show>
		),
	},
]);
