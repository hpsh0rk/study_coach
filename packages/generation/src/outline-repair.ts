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

export const MAX_OUTLINE_SLIDES = 40;

/**
 * Planner-enforced check cadence: wherever lecture pages would run past MAX_LECTURE_RUN minutes
 * without a student activity, a check-for-understanding page is inserted after the last lecture page
 * while keeping total slide count within Outline's hard schema ceiling.
 */
export function enforceCheckCadence(slides: SlideSpec[], maxSlides = MAX_OUTLINE_SLIDES): SlideSpec[] {
  const ids = new Set(slides.map((s) => s.id));
  const nextCfuId = () => {
    let k = 1;
    while (ids.has(`cfu${k}`)) k++;
    const id = `cfu${k}`;
    ids.add(id);
    return id;
  };
  const cadence: SlideSpec[] = [];
  let run = 0;
  let last: SlideSpec | undefined;
  for (const [idx, s] of slides.entries()) {
    const mode = PAGE_TYPES[s.pageType].mode;
    if (mode === "lecture") {
      if (last && run > 0 && run + s.minutes > MAX_LECTURE_RUN && cadence.length + (slides.length - idx) < maxSlides) {
        cadence.push(checkPageAfter(last, nextCfuId()));
        run = 0;
      }
      run += s.minutes;
      last = s;
    } else if (mode === "practice") run = 0;
    cadence.push(s);
  }

  // Repair numbered learning loops (loop > 0) that have 3+ lecture slides and zero learner activity.
  const loops = [...new Set(cadence.map((s) => s.loop).filter((loop) => loop > 0))];
  const insertAfterIndex = new Set<number>();
  let projected = cadence.length;
  for (const loop of loops) {
    if (projected >= maxSlides) break;
    const loopIndices = cadence.map((s, i) => (s.loop === loop ? i : -1)).filter((i) => i >= 0);
    const lectureIndices = loopIndices.filter((i) => PAGE_TYPES[cadence[i]!.pageType].mode === "lecture");
    const hasPractice = loopIndices.some((i) => PAGE_TYPES[cadence[i]!.pageType].mode === "practice");
    if (!hasPractice && lectureIndices.length >= 3) {
      insertAfterIndex.add(lectureIndices[lectureIndices.length - 1]!);
      projected++;
    }
  }
  if (!insertAfterIndex.size) return cadence;
  const out: SlideSpec[] = [];
  cadence.forEach((s, i) => {
    out.push(s);
    if (insertAfterIndex.has(i)) out.push(checkPageAfter(s, nextCfuId()));
  });
  return out;
}

const STOP = new Set(
  "about above after again against also among another because been before being below between both but called can cannot could does doing down each even every from further have having here into its itself just like made make many more most much must only other over same should since some such than that their them then there these they this those through under until upon very want were what when where which while will with within without would your 什么 我们 这个 一个".split(" "),
);

const BRIDGE_CONCEPTS: [key: string, en: RegExp, zh: RegExp][] = [
  ["br:wavelength", /\bwavelengths?\b|\blambda\b|λ/i, /波长/],
  ["br:frequency", /\bfrequenc(?:y|ies)\b|\bhertz\b|\bhz\b/i, /频率|赫兹/],
  ["br:wavespeed", /\bwave\s+speed\b|\bspeed\s+of\s+(?:sound|light|wave)/i, /波速|声速|光速/],
  ["br:amplitude", /\bamplitudes?\b/i, /振幅/],
  ["br:period", /\bperiods?\b/i, /周期/],
  ["br:transverse", /\btransverse\b/i, /横波/],
  ["br:longitudinal", /\blongitudinal\b|\bcompressions?\b|\brarefactions?\b/i, /纵波|疏密|压缩|稀疏/],
  ["br:decibel", /\bdecibels?\b|\bdb\b|\bintensity\b|\bloudness\b/i, /分贝|声强|响度/],
  ["br:ultrasound", /\bultrasound\b|\bultrasonic\b/i, /超声/],
  ["br:echo", /\becho(?:es)?\b|\branging\b|\bsonar\b/i, /回声|声呐|测距/],
  ["br:em", /\belectromagnetic\b|\bspectrum\b/i, /电磁波|电磁谱|波谱/],
  ["br:force", /\bforces?\b|\bnewtons?\b/i, /合力|外力|牛顿/],
  ["br:mass", /\bmass(?:es)?\b|\bkilograms?\b/i, /质量|千克/],
  ["br:acceleration", /\baccelerations?\b|\baccelerate/i, /加速度|匀加速/],
  ["br:inertia", /\binertia\b/i, /惯性/],
  ["br:velocity", /\bvelocit(?:y|ies)\b/i, /末速度|初速度|匀速/],
  ["br:displacement", /\bdisplacements?\b/i, /位移/],
  ["br:work", /\bmechanical\s+work\b|\bwork\s+done\b|\bjoules?\b/i, /做功|机械功|焦耳/],
  ["br:power", /\bpower\b|\bwatts?\b/i, /功率|瓦特/],
  ["br:energy", /\bkinetic\b|\bpotential\b|\benergy\b/i, /动能|势能|能量/],
  ["br:circuit", /\bcurrent\b|\bvoltage\b|\bresistance\b|\bamperes?\b|\bvolts?\b|\bohms?\b/i, /电流|电压|电阻|安培|伏特|欧姆/],
  ["br:stoich", /\bmoles?\b|\bstoichiometr|\blimiting\b|\byield\b/i, /摩尔|物质的量|过量|产率/],
  ["br:cell", /\bcells?\b|\bmembrane\b|\bnucleus\b|\bmitochondr/i, /细胞|细胞膜|细胞核|线粒体/],
  ["br:photo", /\bphotosynthesis\b|\bchlorophyll\b|\bchloroplast/i, /光合作用|叶绿素|叶绿体/],
];

/** Content words of a text: Latin words of 4+ letters, CJK character pairs, and bilingual STEM bridge keys. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z][a-z-]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w.replace(/(?<=[a-z]{3})s$/, ""));
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const [key, enRe, zhRe] of BRIDGE_CONCEPTS) {
    if (enRe.test(text) || zhRe.test(text)) out.add(key);
  }
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
  const validPageTexts = (pages ?? []).filter((p) => valid.has(p.no));
  const index = new Map(validPageTexts.map((p) => [p.no, contentTokens(p.text)]));
  const pagesHaveCjk = validPageTexts.some((p) => hasCjk(p.text));
  const pagesHaveLatin = validPageTexts.some((p) => /[A-Za-z]{4,}/.test(p.text));
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
  const hitCount = (tokens: Set<string>, page: Set<string>) => [...tokens].filter((w) => weight(w) > 0 && page.has(w)).length;
  const best = (tokens: Set<string>) => {
    let top: { no: number; score: number; hits: number } | undefined;
    for (const [no, t] of index) {
      const sc = score(tokens, t);
      const hits = hitCount(tokens, t);
      if (!top || sc > top.score) top = { no, score: sc, hits };
    }
    return top;
  };
  let prevPages: number[] = [];
  return slides.map((s) => {
    const kept = [...new Set(s.sourcePages.filter((p) => valid.has(p)))].sort((a, b) => a - b);
    const outside = [...new Set(s.sourcePages.filter((p) => !valid.has(p)))];
    const slideText = `${s.title} ${s.keyPoints.join(" ")}`;
    const tokens = contentTokens(slideText);
    const crossLanguage = (hasCjk(slideText) && !pagesHaveCjk) || (!hasCjk(slideText) && pagesHaveCjk && !pagesHaveLatin);
    const minInformative = crossLanguage ? 2 : MIN_TOKENS;
    const informative = [...tokens].filter((w) => weight(w) > 0).length;
    let out: SlideSpec = { ...s, sourcePages: kept };
    if (outside.length) {
      const top = tokens.size >= minInformative ? best(tokens) : undefined;
      const suggested = kept.length ? [] : top && top.score > 0 ? [top.no] : prevPages;
      out = { ...out, sourcePages: kept.length ? kept : suggested, sourceIssue: { kind: "out-of-range", cited: outside.slice(0, 20), suggested } };
    } else if (kept.length && index.size > 1 && !NO_MATCH_CHECK.has(s.pageType) && informative >= minInformative) {
      const top = best(tokens);
      const cited = score(tokens, new Set(kept.flatMap((p) => [...(index.get(p) ?? [])])));
      const enoughHits = !crossLanguage || (top?.hits ?? 0) >= 2;
      if (top && enoughHits && !kept.includes(top.no) && top.score >= MIN_BEST && cited < MISMATCH_RATIO * top.score) {
        out = { ...out, sourceIssue: { kind: "mismatch", cited: kept, suggested: [top.no] } };
      }
    }
    if (out.sourcePages.length) prevPages = out.sourcePages;
    return out;
  });
}
