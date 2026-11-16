// Item header (type badge, title, creators, publication line, action buttons) and the Abstract section.
// Port of ui/src/itempane/Header.tsx.
import { createMemo, For, Show, type JSX } from "solid-js";
import { Icon, itemTypeIconName } from "../icons";
import { store } from "../store";
import { DropdownMenu, type MenuItem } from "../ui";
import { shadows } from "../theme";
import { findFullText, openLink, quickCopy, revealAttachment } from "./actions";
import { Field, Section, goToSection, t, tok, tx } from "./kit";
import { locateFileKey, locateItemOf } from "../locate/item";
import { locateMenu } from "../locate/menu";
import { usePane } from "./model";
import { childKind, creatorFull, creatorLast, MONTH_ABBR, parseDate } from "./util";

const MAX_AUTHORS = 6;

/** `h-8 rounded-[7px] border px-3 text-[13px]` header action button. */
function HeaderBtn(p: {
	icon?: string;
	label?: string;
	onClick?: () => void;
	kind?: "primary" | "tint" | "plain";
	title?: string;
	square?: boolean;
	testId?: string;
}): JSX.Element {
	const kind = () => p.kind ?? "plain";
	const fg = () => (kind() === "primary" ? tok("primary-foreground") : kind() === "tint" ? tok("primary-deep") : tok("foreground"));
	return (
		<div
			role="button"
			testId={p.testId}
			aria-label={p.title ?? p.label}
			// only with an action: GPUIX gives a click to the innermost element with a handler, so an empty one here swallowed the
			// click a wrapping DropdownMenu (the "More actions" button) needs
			onClick={p.onClick}
			style={{
				...t("flex h-8 flex-none items-center justify-center"),
				marginRight: 8,
				borderRadius: 7,
				paddingLeft: p.square ? 0 : kind() === "primary" ? 14 : 12,
				paddingRight: p.square ? 0 : kind() === "primary" ? 14 : 12,
				width: p.square ? 32 : undefined,
				borderWidth: kind() === "primary" ? 0 : 1,
				borderColor: kind() === "tint" ? tok("primary-line") : tok("input"),
				backgroundColor: kind() === "primary" ? tok("primary") : kind() === "tint" ? tok("primary-soft") : tok("background"),
				cursor: "pointer",
				...(kind() === "primary" ? { boxShadow: shadows[store.mode()].primary } : {}),
				hover: {
					backgroundColor: kind() === "primary" ? tok("primary") : kind() === "tint" ? tok("primary-tint") : tok("muted"),
					opacity: kind() === "primary" ? 0.92 : 1,
				},
			}}
		>
			<Show when={p.icon}>
				<Icon name={p.icon!} size={14} color={fg()} />
			</Show>
			<Show when={p.label}>
				<text
					style={{
						...tx(kind() === "primary" ? "text-[13px] font-medium" : "text-[13px]"),
						color: fg(),
						whiteSpace: "nowrap",
						marginLeft: p.icon ? 6 : 0,
					}}
				>
					{p.label!}
				</text>
			</Show>
		</div>
	);
}

export function Header(): JSX.Element {
	const pane = usePane();
	const d = () => pane.detail()!;
	const data = () => d().data;
	const st = () => pane.schema()?.itemTypes.find((x) => x.itemType === data().itemType);
	const primary = () => st()?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";

	/** Full names of the primary creators (else everyone but contributors), "First Last". */
	const authors = createMemo(() => {
		const all = data().creators ?? [];
		let pick = all.filter((c) => c.creatorType === primary());
		if (!pick.length) pick = all.filter((c) => c.creatorType !== "contributor");
		if (!pick.length) pick = all;
		return pick.map(creatorFull).filter(Boolean);
	});
	void creatorLast;

	const str = (k: string) => (data()[k] as string | undefined) ?? "";
	const container = () =>
		str("publicationTitle") ||
		str("bookTitle") ||
		str("proceedingsTitle") ||
		str("websiteTitle") ||
		str("blogTitle") ||
		str("publisher");
	const rest = () => {
		const vi = [str("volume"), str("issue") ? `(${str("issue")})` : ""].filter(Boolean).join("");
		const date = parseDate(str("date"));
		const when = date?.y ? [date.m ? MONTH_ABBR[+date.m - 1] : "", date.y].filter(Boolean).join(" ") : "";
		return [vi, str("pages"), when].filter(Boolean);
	};

	const reader = () => {
		const kids = d().children.filter((c) => childKind(c) === "reader");
		const rank = (c: (typeof kids)[number]) => (/pdf/i.test(c.contentType ?? "") ? 0 : /epub/i.test(c.contentType ?? "") ? 1 : 2);
		return [...kids].sort((a, b) => rank(a) - rank(b))[0];
	};
	const hasPdf = () => d().children.some((c) => childKind(c) === "reader" && /pdf/i.test(c.contentType ?? ""));
	const readerLabel = () => {
		const r = reader();
		return /pdf/i.test(r?.contentType ?? "") ? "Open PDF" : /epub/i.test(r?.contentType ?? "") ? "Open EPUB" : "Open snapshot";
	};
	const fileKey = () => locateFileKey(data(), d().children);

	const find = () => void findFullText([data().key], () => void pane.reload());
	const moreItems = (): MenuItem[] => {
		const items: MenuItem[] = [
			{
				label: "Locate",
				icon: "globe",
				submenu: locateMenu(locateItemOf(data()), fileKey(), {
					openUrl: (url) => void openLink(url),
					revealFile: (key) => void revealAttachment(key),
				}),
			},
			{ label: "Copy bibliography", icon: "list", onSelect: () => void quickCopy(data().key, "bibliography", pane.copyText) },
			{ label: "Copy DOI", icon: "copy", disabled: !str("DOI"), onSelect: () => pane.copyText(str("DOI")) },
		];
		if (hasPdf()) items.push({ separator: true }, { label: "Find full text again", icon: "file-search", onSelect: find });
		return items;
	};

	return (
		<div
			data-testid="ip-header"
			style={{
				...t("flex flex-col flex-none w-full"),
				paddingLeft: 20,
				paddingRight: 20,
				paddingTop: 20,
				paddingBottom: 16,
				backgroundColor: tok("header-tint"),
				borderTopLeftRadius: 14,
				borderTopRightRadius: 14,
				borderBottomWidth: 1,
				borderColor: tok("border-soft"),
			}}
		>
			{/* item type badge */}
			<div
				style={{
					...t("flex items-center gap-1.5 rounded-full px-2.5 py-1"),
					alignSelf: "flex-start",
					backgroundColor: tok("primary-tint"),
				}}
			>
				<Icon name={itemTypeIconName(data().itemType)} size={14} color={tok("primary-deep")} />
				<text style={{ ...tx("text-[11px] font-semibold"), color: tok("primary-deep"), whiteSpace: "nowrap" }}>
					{(st()?.label ?? data().itemType).toUpperCase()}
				</text>
			</div>
			<Field
				bare
				multiline
				submitOnEnter
				value={data().title ?? ""}
				placeholder="Untitled"
				rootStyle={{ marginTop: 10 }}
				cls="font-title text-[21px] font-semibold"
				onSave={(v) => void pane.save({ title: v })}
				editStyle={{ fontFamily: tx("font-title").fontFamily as string, fontSize: 18, lineHeight: 24, fontWeight: 600 }}
			/>
			<Show when={authors().length}>
				<div style={{ ...t("flex items-start"), paddingLeft: 6, paddingRight: 6, width: "100%", marginTop: 10 }}>
					<text
						style={{ ...tx("text-[13px] text-secondary-foreground"), lineHeight: 19, flexShrink: 1, minWidth: 0 }}
						aria-label="Creators"
					>
						{authors().slice(0, MAX_AUTHORS).join(", ")}
					</text>
					<Show when={authors().length > MAX_AUTHORS}>
						<div
							role="button"
							aria-label="Show all creators"
							onClick={() => goToSection("info")}
							style={{ cursor: "pointer", marginLeft: 6, flexShrink: 0 }}
						>
							<text
								style={{ ...tx("text-[13px]"), color: tok("primary"), hover: { color: tok("primary-deep") } }}
							>{`+${authors().length - MAX_AUTHORS}`}</text>
						</div>
					</Show>
				</div>
			</Show>
			<Show when={container() || rest().length}>
				<div style={{ ...t("flex flex-wrap items-baseline"), paddingLeft: 6, paddingRight: 6, width: "100%", marginTop: 10 }}>
					<Show when={container()}>
						<text style={{ ...tx("text-[13px] font-semibold"), color: tok("journal"), lineHeight: 19 }}>{container()}</text>
					</Show>
					<For each={rest()}>
						{(r, i) => (
							<text style={{ ...tx("text-[13px] text-muted-foreground"), lineHeight: 19, whiteSpace: "nowrap" }}>
								{(i() > 0 || container() ? " · " : "") + r}
							</text>
						)}
					</For>
				</div>
			</Show>
			{/* each button keeps an 8px right margin; rowGap gives a wrapped row the same space above it */}
			<div style={{ ...t("flex flex-wrap"), rowGap: 8, marginTop: 14 }}>
				<Show when={reader()}>
					<HeaderBtn
						kind="primary"
						icon="book-open"
						label={readerLabel()}
						onClick={() => store.openAttachment(reader()!.key, data().title || reader()!.title || "Reader", data().key)}
					/>
				</Show>
				<HeaderBtn icon="quote" label="Cite" onClick={() => void quickCopy(data().key, "citation", pane.copyText)} />
				<Show when={!hasPdf()}>
					<HeaderBtn
						kind="tint"
						icon="download"
						label="Find full text"
						title="Find an open-access or institutional PDF and attach it"
						onClick={find}
					/>
				</Show>
				<DropdownMenu
					align="start"
					width={224}
					items={moreItems}
					trigger={<HeaderBtn square icon="ellipsis" title="More actions" testId="ip-more" />}
				/>
			</div>
		</div>
	);
}

export function AbstractSection(): JSX.Element {
	const pane = usePane();
	return (
		<Section id="abstract" title="Abstract" icon="align-left">
			<Field
				multiline
				value={pane.detail()?.data.abstractNote ?? ""}
				placeholder="Add abstract"
				cls="text-[13px] leading-[19px]"
				onSave={(v) => void pane.save({ abstractNote: v })}
			/>
		</Section>
	);
}
