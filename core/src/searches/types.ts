// Shared types for advanced / saved searches (imported by the UI as well).

export const OPERATORS = ["is", "isNot", "contains", "doesNotContain", "beginsWith", "isBefore", "isAfter", "isInTheLast"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface SearchCondition {
	/** title | creator | year | date | dateAdded | dateModified | publicationTitle | any schema field | itemType | tag | collection | note | attachmentFileType | fulltextContent | anyField */
	field: string;
	operator: Operator;
	/** isInTheLast takes "<n> <days|weeks|months|years>"; collection takes a collection key (or name). */
	value: string;
}

export interface SearchOptions {
	match: "all" | "any";
	/** A match on a child (note, attachment) also lists its parent, and conditions may be met by different members of a family. */
	includeParentsAndChildren: boolean;
	searchSubcollections: boolean;
	/** Only top-level items count as matches (children never lift their parent). */
	topLevelOnly: boolean;
	includeTrash: boolean;
}

export interface SearchDefinition {
	conditions: SearchCondition[];
	options: SearchOptions;
}

export interface SavedSearch extends SearchDefinition {
	key: string;
	name: string;
	dateModified: string;
}

export const QUICK_MODES = ["titleCreatorYear", "fields", "everything"] as const;
export type QuickSearchMode = (typeof QUICK_MODES)[number];

export const DEFAULT_OPTIONS: SearchOptions = {
	match: "all",
	includeParentsAndChildren: false,
	searchSubcollections: false,
	topLevelOnly: false,
	includeTrash: false,
};
