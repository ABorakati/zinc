# Fuzz tests

Property-based tests (fast-check) that feed random and mutated input to the code that reads untrusted data. They run inside
`bun test`: no Node, no extra tools. Core tests are `core/test/fuzz/*.fuzz.test.ts`, the GPUI ones are
`gpui-ui/src/**/*.fuzz.test.ts` (shared helpers: `harness.ts` here, `gpui-ui/src/fuzzHarness.ts` there).

| File | Targets |
| --- | --- |
| `io.fuzz.test.ts` | RIS, BibTeX, EndNote XML, CSL JSON, Zotero RDF, MODS, PubMed nbib importers, format detection, `importText`; export -> import round trips |
| `zip.fuzz.test.ts` | `websync/zip.ts`: zip-slip names, zip bombs, truncated and corrupt archives, writes only into a temp folder |
| `docfields.fuzz.test.ts` | Word field codes, document prefs, RTF/HTML runs (`cite/docfields.ts`, `word/sidebar/src/cited.ts`) |
| `bbt.fuzz.test.ts` | citekey formula parser and evaluator, Unicode to LaTeX |
| `apply.fuzz.test.ts` | Web API / Zotero pull apply (`sync/apply.ts`) and connector translator JSON: database integrity, no partial writes |
| `http.fuzz.test.ts` | core HTTP API on a real server (free port): no 5xx, still answering; the `apiRequestRejected` guard |
| `pure.fuzz.test.ts` | `venue.ts`, saved-search SQL compiler (`searches/compile.ts`) |

## Run

```sh
cd core
bun test test/fuzz                       # normal: about 100-400 cases per property, under a minute in total
ZN_FUZZ_RUNS=5000 bun test test/fuzz     # long run (overnight); every property runs 5000 cases
ZN_FUZZ_SEED=12345 bun test test/fuzz    # fixed starting seed

cd ../gpui-ui
bun test src/locate/locate.fuzz.test.ts src/sidebar/collectionRows.fuzz.test.ts
```

## Replay a failure

A failing property prints the shrunk counterexample and a `replay:` line, for example:

```
[fuzz] FAILED ris: random text never throws and yields valid items
  replay: ZN_FUZZ_SEED=1912558865 ZN_FUZZ_PATH="23:1:1:2" bun test <file> -t "ris: random text never throws and yields valid items"
```

Run that command (with the real file name) to get exactly the same failing case. Once the bug is fixed, add the shrunk input as a
plain `test()` in the same file so it stays covered without the fuzzer.

## Notes

- Tests only use temp folders and databases (the `bunfig.toml` preload routes `os.tmpdir()`), never the user's library, and never the
  network. The HTTP test starts its own server on port 0.
- A case that runs longer than its time box (3 s by default) fails: that is how hangs and quadratic blow-ups are caught.
- Rust (`gpui-ui/native/pdf`) is not fuzzed: `cargo-fuzz` needs nightly and libFuzzer, and the crate has no PDF test setup.
