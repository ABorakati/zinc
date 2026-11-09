import type { Database } from "bun:sqlite";

/** One step of the library's schema history. See list.ts for how to add one. */
export interface Migration {
	/** 1, 2, 3 ... with no gaps. Recorded in meta.schema_version once applied. */
	id: number;
	/** Short kebab-case label, used in error messages. */
	name: string;
	/**
	 * Changes the schema and/or data. Runs inside a transaction that the runner owns (one transaction covers every pending
	 * migration, so a failure undoes all of them): do NOT begin or commit one yourself, and do not call db.transaction().
	 * Foreign keys are switched off for the run, so a table rebuild (create new, copy, drop old, rename) is safe; the runner
	 * checks foreign keys afterwards. Throw to abort.
	 */
	up(db: Database): void;
	/**
	 * Set only on a migration that is idempotent (CREATE ... IF NOT EXISTS and the like) and that older libraries may have
	 * recorded without really having applied: a library recorded at exactly this id re-runs it when later migrations are pending.
	 * Only the baseline uses this.
	 */
	reapply?: boolean;
}

/** The library carries a schema_version newer than this build knows. Nothing was changed. */
export class LibraryTooNewError extends Error {
	constructor(
		public readonly found: number,
		public readonly supported: number,
	) {
		super(
			`This library was opened by a newer version of Zinc (its schema is version ${found}; this build understands up to version ${supported}). ` +
				"Update Zinc to open it. The library has not been changed.",
		);
		this.name = "LibraryTooNewError";
	}
}

/** A migration (or the integrity check after it) failed. The transaction was rolled back, so the library file is unchanged. */
export class MigrationError extends Error {
	constructor(
		message: string,
		public readonly backup: string | undefined,
		public readonly migration?: { id: number; name: string },
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "MigrationError";
	}
}

export interface MigrateOptions {
	/** Override the migration list (tests). */
	migrations?: readonly Migration[];
	/** Clock for backup names (tests). */
	now?: () => Date;
	/** How many library.backup-v*-to-v*-*.sqlite files to keep (default 3). */
	keepBackups?: number;
}

export interface MigrateResult {
	from: number;
	to: number;
	/** ids applied, in order (empty when the library was already current). */
	applied: number[];
	/** Path of the pre-upgrade backup, when one was made. */
	backup?: string;
}
