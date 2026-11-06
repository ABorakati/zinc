# Zotero compatibility tests

Tests ported or derived from Zotero's own test suites, run against zotero-next's own code (not against the Zotero code
vendored in `core/vendor/zotero`, which is Zotero's already).

Run: `bun test test/zotero-compat` from `core/`. No network and no Zotero profile are used; databases are temp files.

## Licence

NOTICE: the expected values, test names and fixtures in this folder are taken from Zotero's tests and data and are licensed
under the GNU Affero General Public License, version 3, like `core/vendor/zotero`. Zotero is Copyright (c) Corporation for
Digital Scholarship, Vienna, Virginia, USA, and the Center for History and New Media, George Mason University. Only the
expected values were copied and the test code was rewritten as Bun tests; Zotero's Mocha harness is not vendored.

Each test file names its upstream file and commit in its header:

| Upstream | Commit |
|---|---|
| https://github.com/zotero/zotero (`test/tests/*.js`) | `a14e76b358c88779e293f03e56e7900a5b6c4ad6` |
| https://github.com/zotero/utilities (`test/tests/*.js`, `test/data/citeProcJSExport.json`) | `4051881d59c6c12d34417d4c226f37218051be90` |
| https://github.com/zotero/translators (`testCases` inside the vendored translators) | `9d04f4b8b4e44b46782c8572fdb834147df18979` |
| https://github.com/zotero/zotero-schema (`schema.json`, in `core/vendor/zotero`) | `b86c79b56479cadac3288e1f122cf34ef04e8809` |

`data/citeProcJSExport.json` is upstream's `test/data/citeProcJSExport.json` unchanged.

## Files

| File | Subject (zotero-next code) | Upstream |
|---|---|---|
| `date.test.ts` | `zotero-db/zotero-date.ts`, `zotero-db/mapping.ts` (dates written into zotero.sqlite) | zotero/utilities `dateTest.js`, zotero `dateTest.js` |
| `csl-json.test.ts` | `cite/csl.ts` itemToCsl, `io/csljson.ts` | zotero/utilities `utilities_itemTest.js` |
| `identifiers.test.ts` | `additems/identifiers.ts`, `references/ids.ts`, `duplicates/detect.ts` | zotero `utilities_internalTest.js`, `duplicatesTest.js`; zotero/utilities `utilitiesTest.js` |
| `names.test.ts` | `io/common.ts` parseName, `io/ris.ts` | zotero/utilities `utilitiesTest.js` (cleanAuthor) |
| `schema.test.ts` | `schema-data`, `convertItemType`, `searches/compile.ts` field kinds | zotero `itemFieldsTest.js`, `itemTest.js` (#setType) |
| `search.test.ts` | `searches/compile.ts` through `listItems` | zotero `searchTest.js` |
| `translator-import.test.ts` | `io/{bibtex,ris,csljson,endnote,mods}.ts` | `testCases` of the BibTeX, RIS, CSL JSON, Endnote XML and MODS translators |

## Oracle

`oracle.ts` starts `oracle-child.ts`, a Bun child process that loads Zotero's vendored `utilities` (date.js, utilities_item.js,
schema, cachedTypes) the way translation-server does, and answers JSON requests. A test can ask "what does Zotero itself return
for this input?" (`strToMultipart`, `itemToCSLJSON`, `cleanAuthor`, `cleanISBN`, `toISBN13`, ...) and compare it with
zotero-next's own function on a corpus. The child keeps `globalThis.Zotero` out of the test process. Note that the oracle runs
Zotero's Node build: where the Zotero client behaves differently (day suffixes such as "26th" are only recognised in the
client), the test says so.

## Reading the results

- A passing test is an upstream expectation that zotero-next also meets.
- `test.todo("name: reason")` is a difference that was looked at. Either zotero-next does not implement the feature, or it
  behaves differently on purpose; the reason is in the name. Expectations were not weakened to make a test pass.
- `translator-import.test.ts` has a `KNOWN` table; a guard test fails when a known difference starts to pass, so the table
  cannot go stale.
