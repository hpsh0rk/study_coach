import { MAX_LECTURE_RUN, PAGE_TYPES } from "@kj/pedagogy";
import type { PageText, PageType, SlideSpec } from "@kj/schema";
import { layoutForPageType } from "@kj/templates";

const hasCjk = (s: string) => /[\u3400-\u9fff]/.test(s);

function checkPageAfter(last: SlideSpec, id: string): SlideSpec {
  const head = last.title.replace(/^(check|检查理解)[:：]\s*/i, "").slice(0, 120);
  return {
    id,
    pageType: "check",
    layout: layoutForPageType("check"),
    title: hasCjk(head) ? `检查理解：${head}` : `Check: ${head}`,
    purpose: "Hinge question · 自动插入：连续讲授超过 10 分钟",
    keyPoints: [last.title.slice(0, 160)],
    visual: "none",
    minutes: PAGE_TYPES.check.minutes,
    sourcePages: last.sourcePages,
    loop: last.loop,
  };
}

/**
 * Planner-enforced check cadence: wherever lecture pages would run past MAX_LECTURE_RUN minutes
 * without a student activity, a check-for-understanding page is inserted after the last lecture page.
 */
export function enforceCheckCadence(slides: SlideSpec[]): SlideSpec[] {
  const ids = new Set(slides.map((s) => s.id));
  const out: SlideSpec[] = [];
  let run = 0;
  let last: SlideSpec | undefined;
  let k = 0;
  for (const s of slides) {
    const mode = PAGE_TYPES[s.pageType].mode;
    if (mode === "lecture") {
      if (last && run > 0 && run + s.minutes > MAX_LECTURE_RUN) {
        let id: string;
        do id = `cfu${++k}`;
        while (ids.has(id));
        ids.add(id);
        out.push(checkPageAfter(last, id));
        run = 0;
      }
      run += s.minutes;
      last = s;
    } else if (mode === "practice") run = 0;
    out.push(s);
  }
  return out;
}

const STOP = new Set(
  "about above after again against also among another because been before being below between both but called can cannot could does doing down each even every from further have having here into its itself just like made make many more most much must only other over same should since some such than that their them then there these they this those through under until upon very want were what when where which while will with within without would your 什么 我们 这个 一个".split(" "),
);

/** Content words of a text: Latin words of 4+ letters (plural s stripped) and CJK character pairs. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z][a-z-]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w.replace(/(?<=[a-z]{3})s$/, ""));
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

/** Spreading pages (cover / recap / summary / exit) cite broadly; their text match says little. */
const NO_MATCH_CHECK = new Set<PageType>(["cover", "retrieval", "summary", "exit"]);
const MIN_TOKENS = 4;
const MIN_BEST = 0.35;
const MISMATCH_RATIO = 0.5;

/**
 * Source-page check, never silent: out-of-range pages are replaced by the best-matching page of the
 * selection (else the previous slide's pages) and flagged; in-range pages whose text does not match the
 * slide while another page clearly does are flagged as a likely shift. Flags surface as 待核实.
 */
export function checkSourcePages(slides: SlideSpec[], validPages: number[], pages?: PageText[]): SlideSpec[] {
  const valid = new Set(validPages);
  const index = new Map((pages ?? []).filter((p) => valid.has(p.no)).map((p) => [p.no, contentTokens(p.text)]));
  // Words on every page of the selection ("wave" in a waves chapter) say nothing about which page a slide is from.
  const df = new Map<string, number>();
  for (const t of index.values()) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w: string) => (df.has(w) ? Math.log(index.size / df.get(w)!) : 0);
  const score = (tokens: Set<string>, page: Set<string>) => {
    let hit = 0;
    let all = 0;
    for (const w of tokens) {
      const x = weight(w);
      all += x;
      if (page.has(w)) hit += x;
    }
    return all > 0 ? hit / all : 0;
  };
  const best = (tokens: Set<string>) => {
    let top: { no: number; score: number } | undefined;
    for (const [no, t] of index) {
      const sc = score(tokens, t);
      if (!top || sc > top.score) top = { no, score: sc };
    }
    return top;
  };
  let prevPages: number[] = [];
  return slides.map((s) => {
    const kept = [...new Set(s.sourcePages.filter((p) => valid.has(p)))].sort((a, b) => a - b);
    const outside = [...new Set(s.sourcePages.filter((p) => !valid.has(p)))];
    const tokens = contentTokens(`${s.title} ${s.keyPoints.join(" ")}`);
    const informative = [...tokens].filter((w) => weight(w) > 0).length;
    let out: SlideSpec = { ...s, sourcePages: kept };
    if (outside.length) {
      const top = tokens.size >= MIN_TOKENS ? best(tokens) : undefined;
      const suggested = kept.length ? [] : top && top.score > 0 ? [top.no] : prevPages;
      out = { ...out, sourcePages: kept.length ? kept : suggested, sourceIssue: { kind: "out-of-range", cited: outside.slice(0, 20), suggested } };
    } else if (kept.length && index.size > 1 && !NO_MATCH_CHECK.has(s.pageType) && informative >= MIN_TOKENS) {
      const top = best(tokens);
      const cited = score(tokens, new Set(kept.flatMap((p) => [...(index.get(p) ?? [])])));
      if (top && !kept.includes(top.no) && top.score >= MIN_BEST && cited < MISMATCH_RATIO * top.score) {
        out = { ...out, sourceIssue: { kind: "mismatch", cited: kept, suggested: [top.no] } };
      }
    }
    if (out.sourcePages.length) prevPages = out.sourcePages;
    return out;
  });
}
