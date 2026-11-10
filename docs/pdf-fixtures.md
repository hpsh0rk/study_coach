# PDF classification and routing fixtures

All PDF tests are offline. `node scripts/make-fixture-pdf.mjs` regenerates the committed files from hand-authored text and vector shapes, standard PDF fonts, and a 1×1 grey PNG. No fixture contains third-party textbook content.

## Inventory

| File | Purpose |
|---|---|
| `fixtures/pdfs/classification-corpus.pdf` | Fourteen pages: every supported page kind in English and Chinese (`text`, `blank`, `scanned`, `garbled`, `formula-lost`, `formula-text`, `table`). It also carries exact printed labels and three bookmarks whose ranges partition the corpus. |
| `fixtures/pdfs/classification-corpus.json` | Reviewed oracle for every corpus page: language, physical/text-layer fact, required and forbidden extraction canaries, printed label, expected kind, and parser route. |
| `fixtures/pdfs/waves-mini.pdf` | Eight-page born-digital E2E textbook with nested bookmarks. |
| `fixtures/pdfs/newton-zh-cid.pdf` | Chinese Adobe-GB1 CID text plus two image-heavy pages; guards bundled CMap loading. |
| `fixtures/pdfs/kinematics-outlines.pdf` | English prose with formulas drawn only as vector glyph outlines. |

The corpus test requires all 22 extraction canaries, forbids all 8 tokens that the text layer must not expose, matches 14 labels and 14 kinds exactly, and matches all 3 bookmark-derived chapter ranges. These are semantic text and identity checks; tests do not compare PDF bytes, rendered pixels, or pdf.js operator details.

## Routing oracle

- `scanned`, `garbled`, and `formula-lost` pages route automatically.
- `formula-text` and `table` pages route only through the requested refinement path.
- `text` and `blank` pages do not route.
- With no parser enabled, every automatic page routes to `manual`.
- External-parser result markers must be exactly `KJPAGE 1…N`, once each and in order. Missing, duplicate, extra, fake body-line, or out-of-order markers reject the whole result so no partial text can be attached to the wrong requested page.
- A non-contiguous request uses distinct result canaries to prove ordinal result 1 maps to the first requested PDF page and result 2 to the second.

## Measured baseline and result

Before the corpus-driven fix, classification matched 12/14 pages (85.7%): both fully garbled pages were called blank because zero countable words was checked before bad-character density. Automatic routing therefore selected 4/6 required pages (66.7%). Moving the bad-character check ahead of the blank check yields 14/14 classification and 6/6 automatic routing; refinement remains 4/4.

Before strict marker validation, 0/6 malformed `KJPAGE` mutations produced an explicit failure. All 6/6 are now rejected as unsafe, while clean ordered results and non-contiguous page mapping remain exact.

## Remaining real-parser gaps

This corpus proves deterministic pdf.js classification and local routing, not OCR or formula reconstruction quality. A live MinerU or vision-parser evaluation must run these same page identities through the real service and compare returned canaries/formulas/tables to a separately reviewed golden. The synthetic grey scan cannot measure OCR recall, and the compact corpus does not represent complex publisher layouts such as multi-column reading order, merged table cells, figure labels, or partially corrupt embedded fonts.
