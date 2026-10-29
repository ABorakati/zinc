import {
	Book, BookOpen, FileText, Globe, GraduationCap, Link, Newspaper, Paperclip, Presentation, File as FileIcon, FileClock, ScrollText, type LucideProps,
} from "lucide-solid";
import type { Component } from "solid-js";

const TYPE_ICONS: Record<string, Component<LucideProps>> = {
	journalArticle: FileText,
	magazineArticle: Newspaper,
	newspaperArticle: Newspaper,
	book: Book,
	bookSection: BookOpen,
	webpage: Globe,
	blogPost: Globe,
	conferencePaper: Presentation,
	thesis: GraduationCap,
	report: ScrollText,
	preprint: FileClock,
};

export const itemTypeIcon = (t: string): Component<LucideProps> => TYPE_ICONS[t] ?? FileIcon;

export const itemTypeLabel = (t: string) =>
	t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Icon for an attachment by content type. */
export const attachmentIcon = (contentType: string | null | undefined, linkMode?: string | null): Component<LucideProps> =>
	/pdf/i.test(contentType ?? "") ? FileText : /epub/i.test(contentType ?? "") ? BookOpen : linkMode === "linked_url" ? Link : Paperclip;
