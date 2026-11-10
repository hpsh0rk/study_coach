import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PageSeparatorError, separatorText, splitSeparated } from "../src/index.ts";

interface PageGolden {
  required: string[];
  formulas: string[];
  table: string[];
}

interface CorpusPage {
  no: number;
  required: string[];
  decisive?: { formulas: string[]; table: string[] };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const corpus = JSON.parse(readFileSync(resolve(root, "fixtures/pdfs/classification-corpus.json"), "utf8")) as {
  recordedMineru: { fixture: string; pages: ({ ordinal: number; pdfPage: number } & PageGolden)[] };
  pages: CorpusPage[];
};
const recorded = JSON.parse(readFileSync(resolve(root, "apps/app/src/textbook/parsers/mineru-recorded.json"), "utf8")) as {
  request: { upload: string };
  markdown: string;
};

const prose = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function math(text: string): string {
  let out = text.normalize("NFKC");
  for (let i = 0; i < 4; i++) out = out.replace(/\\(?:mathtt|mathsf|mathrm)\s*\{\s*([^{}]*?)\s*\}/g, "$1");
  return out
    .replace(/\^\s*\{\s*([^{}]*?)\s*\}/g, "^$1")
    .replace(/[${}\\~\s]/g, "")
    .toLowerCase();
}

function issues(text: string, golden: PageGolden): string[] {
  const normal = prose(text);
  const equations = math(text);
  return [
    ...golden.required.filter((token) => !normal.includes(prose(token))).map((token) => `required:${token}`),
    ...golden.formulas.filter((token) => !equations.includes(math(token))).map((token) => `formula:${token}`),
    ...golden.table.filter((token) => !normal.includes(prose(token))).map((token) => `table:${token}`),
  ];
}

function corpusGolden(no: number): PageGolden {
  const page = corpus.pages.find((candidate) => candidate.no === no)!;
  return { required: page.required, formulas: page.decisive?.formulas ?? [], table: page.decisive?.table ?? [] };
}

describe("recorded MinerU result against reviewed PDF goldens", () => {
  const recordedGolden = corpus.recordedMineru.pages[0]!;
  const recordedText = splitSeparated(recorded.markdown, 1)[0]!;

  it("proves the recording's source page identity, canaries and both outline formulas", () => {
    expect(recorded.request.upload).toBe(`${corpus.recordedMineru.fixture} page ${recordedGolden.pdfPage} behind a KJPAGE ${recordedGolden.ordinal} separator page`);
    expect(issues(recordedText, recordedGolden)).toEqual([]);
  });

  it("does not let formula similarity masquerade as the corpus formula page or table page", () => {
    expect(issues(recordedText, corpusGolden(9))).toEqual(["required:EN_LOST_CANARY"]);
    expect(issues(recordedText, corpusGolden(13))).toEqual(
      expect.arrayContaining(["required:EN_TABLE_CANARY", "required:12 m/s", "table:time | velocity", "table:12 m/s"]),
    );

    const validTable = splitSeparated(`${separatorText(1)}\nEN_TABLE_CANARY\n\ntime | velocity\n0 s | 12 m/s`, 1)[0]!;
    expect(issues(validTable, corpusGolden(13))).toEqual([]);
  });

  it("rejects every malformed marker identity as a whole batch before any page can be saved", () => {
    const table = "EN_TABLE_CANARY\n\ntime | velocity\n0 s | 12 m/s";
    const valid = `${separatorText(1)}\n${recordedText}\n${separatorText(2)}\n${table}`;
    let saved = 0;
    const replay = (markdown: string) => {
      const pages = splitSeparated(markdown, 2);
      const failures = [...issues(pages[0]!, recordedGolden), ...issues(pages[1]!, corpusGolden(13))];
      if (failures.length) throw new Error(failures.join(", "));
      saved += pages.length;
    };
    replay(valid);
    expect(saved).toBe(2);

    const malformed = [
      `${recordedText}\n${separatorText(2)}\n${table}`,
      `${separatorText(1)}\n${recordedText}\n${separatorText(2)}\n${table}\n${separatorText(2)}\nduplicate`,
      `${separatorText(2)}\n${table}\n${separatorText(1)}\n${recordedText}`,
      `${valid}\n${separatorText(99)}\nextra`,
      `${separatorText(1)}\n${recordedText}\nKJPAGE 99\n${separatorText(2)}\n${table}`,
      `${separatorText(1)}\n${recordedText}\n${separatorText(3)}\n${table}`,
    ];
    for (const markdown of malformed) {
      expect(() => replay(markdown)).toThrow(PageSeparatorError);
      expect(saved).toBe(2);
    }
  });
});
