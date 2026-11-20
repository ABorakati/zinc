# `src/format` — Result Formatting Notes

## What is implemented

- **[`src/format/index.ts`](./index.ts)**: exports `resultWriter: ResultWriter` (satisfying `src/contracts.ts`), the shared configuration object `formatOptions` (`{ strategy: "insertText" }` by default), `setWriteStrategy(strategy)`, `createResultWriter(options)`, and the underlying helpers so the coordinating session or `src/host` can switch strategies in one line.
- **[`src/format/writer.ts`](./writer.ts)**: implements both `queueResult(field, runs)` strategies without calling `context.sync()`:
  1. **`"insertText"` (`queueResultInsertText`)**: normalizes `\r\n` / `\r` to `\n`, merges adjacent runs with identical formatting, writes the first run via `field.result.insertText(t, "Replace")` and subsequent runs via `field.result.insertText(t, "End")` (staying inside the field delimiters), and sets character formatting on each returned `Word.Range.font`. Inactive flags (`false`) are assigned before active flags (`true`) so inherited formatting from old field text or preceding runs is cleared (matching `WordDoc.SetResult` in `word/addin/WordDoc.cs`) and `superscript` / `subscript` never clobber each other. Guards `font.smallCaps` behind `Office.context.requirements.isSetSupported("WordApiDesktop", "1.3")` when available so Word on the web does not fail with `PropertyNotAvailable`.
  2. **`"ooxml"` (`queueResultOoxml`)**: converts `runs` into a Flat OPC WordprocessingML package and issues a single `field.result.insertOoxml(xml, "Replace")` command.
- **[`src/format/ooxml.ts`](./ooxml.ts)**: pure WordprocessingML generator (`runsToOoxml`, `runsToBodyXml`, `escapeXmlText`, `escapeXmlAttr`, `splitRunsIntoParagraphs`, `normalizeRunsForInsertText`):
  - Strips illegal XML 1.0 control characters (`< 0x20` except `\t`, `\n`, `\r`, plus `0xFFFE`/`0xFFFF` and lone UTF-16 surrogates) and escapes `&`, `<`, `>`, `"`, `'`.
  - Preserves leading/trailing spaces on `<w:t xml:space="preserve">` and converts `\t` (used by CSL `second-field-align`) into `<w:tab/>`.
  - Emits `<w:rPr>` children in ECMA-376 `EG_RPrBase` sequence order (`<w:b/>`, `<w:i/>`, `<w:smallCaps/>`, `<w:vertAlign w:val="superscript|subscript"/>`), with optional `resetFormatting: true` to emit explicit `w:val="0"` / `baseline` resets.
  - Splits `\r\n`, `\r`, and `\n` into separate `<w:p>` elements, with optional `<w:pPr>` in ECMA-376 `CT_PPrBase` order (`<w:pStyle w:val="Bibliography"/>`, `<w:tabs>`, `<w:spacing>`, `<w:ind>`).
- **[`src/format/bibliography.ts`](./bibliography.ts)**: implements `queueBibliographyFormat(field, fmt)` (matching `WordDoc.ApplyBibliographyFormat` plus `lineSpacing`):
  - Applies `"Bibliography"` (`Word.BuiltInStyleName.bibliography`): uses `field.result.styleBuiltIn = "Bibliography"` when built-in (portable across localized Desktop Word UI languages), or creates the missing paragraph style via `document.addStyle("Bibliography", "Paragraph")` and assigns `field.result.style = "Bibliography"` when missing/custom (Word on the web).
  - Applies `leftIndent = 36` and `firstLineIndent = -36` when `fmt.hanging || fmt.secondFieldAlign`, `spaceAfter = fmt.entrySpacing * 12` pt, and `lineSpacing = fmt.lineSpacing * 12` pt.
  - Exports `queueLoadBibliographyStyle(context)` and `ensureBibliographyStyle(context)` for pre-loading/creating `"Bibliography"` across `context.sync()` boundaries in real Office.js (see below).
- **[`test/format/`](../../test/format/)**: unit tests for pure OOXML generation (`ooxml.test.ts`) and command-recording fake tests for both strategies and bibliography formatting (`fakes.ts`, `writer.test.ts`).

## Recommended strategy: `"insertText"` (default), with `"ooxml"` tested for bibliographies

**Recommendation:** keep **`"insertText"`** (`formatOptions.strategy = "insertText"`) as the default strategy, especially for inline and footnote citations, and test **`"ooxml"`** in real Word both globally and as a bibliography-specific option.

Why `"insertText"` is safer as the default:
1. **Avoids `field.result` rich-insertion bugs**: `field.result.insertHtml` had a long chain of Word Online / Office.js regressions where content landed outside the field (`OfficeDev/office-js#3613`) or invalidated tracked `Field` proxies on subsequent `field.code` / `insertText` writes (`#4388`, `#4891`). `field.result.insertText` (`"Replace"` then `"End"`) is Microsoft's recommended primitive for rich text inside `ADDIN` fields.
2. **Guaranteed inline for citations**: `insertOoxml` requires wrapping runs inside `<w:body><w:p>...</w:p></w:body>`. Replacing an inline or empty `field.result` with block-level `<w:p>` OOXML risks injecting a spurious paragraph break, altering list numbering (`#1914`, `#6904`), or landing outside an empty `ADDIN` field boundary (`#6717`) on some Word builds. `insertText` never introduces paragraph breaks unless the string contains `\n`.
3. **Preserves surrounding font family and size**: citations in 10 pt footnotes, headings, or custom journal templates naturally inherit the surrounding font family/size/color under `insertText` while we explicitly reset/toggle only the 5 CSL character marks.
4. **Low command volume**: numeric citations (`[1]`, `1–3`) and most author-date citations (`(Smith & Haddad, 2021)`) normalize to 1–3 runs, all queued in memory and flushed in the caller's existing chunked `context.sync()`.

Where `"ooxml"` has clear advantages worth testing in real Word:
1. **Large bibliographies**: a 150-entry bibliography (~450+ formatted runs) collapses into a single `field.result.insertOoxml(xml, "Replace")` call with explicit `<w:p>` elements.
2. **Small caps in Word on the web**: `Word.Font.smallCaps` is in `WordApiDesktop 1.3`, whereas `<w:smallCaps/>` in WordprocessingML is standard OpenXML.
3. **Tab stops for `second-field-align` (`#3585`)**: Office.js still has no JS API for paragraph tab stops (`OfficeDev/office-js#3585`), whereas `runsToOoxml(..., { bibliographyStyle: true, bibliographyFormat: fmt })` emits `<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>` directly in `<w:pPr>`.

## What is untested in real Word

The coordinating session should verify on Word for Windows, Word for Mac, and Word on the web:
1. **Strategy `"ooxml"` on inline and footnote citations**: confirm `field.result.insertOoxml(xml, "Replace")` stays inside the `ADDIN` field, does not add a trailing paragraph break, keeps `field` / `field.result` proxies valid for later writes, and preserves footnote font size.
2. **Multiline bibliography paragraphs under `"insertText"`**: confirm `\n` in `field.result.insertText(..., "Replace" | "End")` creates true paragraphs (`<w:p>`, not `<w:br/>` soft breaks) on all three hosts so hanging indents (`leftIndent = 36`, `firstLineIndent = -36`) and `spaceAfter` apply per entry, and check that Word Online's multiline `ADDIN` style fix (`#3621`) holds.
3. **Word's >50% italic rule on bibliography style assignment**: in Word, applying a paragraph style (`styleBuiltIn = "Bibliography"`) *after* setting run italics can clear direct italics on entries where an italicized book title exceeds 50% of the paragraph's length. If observed, call `queueBibliographyFormat` *before* `queueResult` when rewriting an existing bibliography (or use `"ooxml"` with `{ bibliographyStyle: true, bibliographyFormat: fmt }`).
4. **`Word.Font.smallCaps` on Mac and Web**: verify what `Office.context.requirements.isSetSupported("WordApiDesktop", "1.3")` returns on Word for Mac vs Word on the web, and whether Word on the web accepts `<w:smallCaps/>` via `insertOoxml`.
5. **Footnote `field.result` ranges (`#3591`)**: verify multi-run citations inside footnotes do not drop or shift the leading character when read back via `field.result.text`.

## Open questions and wishes for other parts

1. **Pre-loading `"Bibliography"` style for `src/host` (Word on the web)**:
   - Because `ResultWriter.queueBibliographyFormat(field, fmt)` in `src/contracts.ts` is synchronous (`void`) and must not call `context.sync()`, real Office.js cannot read `getByNameOrNullObject("Bibliography").isNullObject` inside `queueBibliographyFormat` unless that style proxy was loaded before an earlier `sync()`.
   - **Zero-extra-sync integration**: in `src/host`, whenever a write batch (`doc.insert`, `doc.set`, `doc.setMany`) includes a `"bibl"` field, call `queueLoadBibliographyStyle(context)` (exported from `src/format`) right before the pre-write `context.sync()` that switches `changeTrackingMode` to `"Off"`. `queueBibliographyFormat` will then see `isNullObject` synchronously, queue `document.addStyle("Bibliography", "Paragraph")` once if missing, and assign `result.style = "Bibliography"` in the write batch. (Alternatively, `await ensureBibliographyStyle(context)` runs it as a self-contained preflight, or `ResultWriter` in `src/contracts.ts` could gain an optional `prepareBibliography?(context: Word.RequestContext): Promise<void>`.)
2. **Forwarding `lineSpacing` from `core` and `word/sidebar`**:
   - `BibliographyFormat` in `src/contracts.ts` defines `lineSpacing?: number`, and `src/format` implements `lineSpacing * 12` pt (`w:line = lineSpacing * 240`). Currently `BibliographyOut` in `core/src/cite/docformat.ts` and `word/sidebar/src/app.ts` only forward `hanging`, `secondFieldAlign`, and `entrySpacing`; forwarding `params.linespacing` from `citeproc` will enable `lineSpacing` end-to-end.

## Bibliography format: as Zotero (2026-11-20)

Zotero gives the bibliography's paragraphs the "Bibliography" style only and puts the format on the style itself, once per
document (`bibliographyStyleHasBeenSet`): `queueBibliographyFormat` now sets the style only, and `applyBibliographyStyleFormat`
sets Zotero's values (core `bibliographyStyleFormat`, sent by the sidebar as `styleFormat`) on the style. Compared in Word with the
Windows add-in on the same scenario, everything matches except two things Office.js cannot express:
- **Tab stops** (numbered styles: one at the indent): `Word.ParagraphFormat` has no tab stops, even in the preview API. Rendering is
  unaffected: Word uses a hanging indent as an implicit tab stop, so labels and text line up the same.
- **Line spacing rule**: `lineSpacing` writes "at least N pt" (`w:lineRule="atLeast"`), Zotero writes "single/multiple"
  (`auto`). For text up to the line height it looks the same.
