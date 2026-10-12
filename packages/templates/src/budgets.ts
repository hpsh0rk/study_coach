/** Logical canvas (pedagogy T-01): everything is laid out at 1920×1080 and scaled. */
export const CANVAS = { width: 1920, height: 1080 } as const;
/** Type scale (T-02): body never shrinks below FONT.bodyMin when fitting. */
export const FONT = { title: 72, body: 56, bodyMin: 48, label: 40, source: 28 } as const;

/** A text budget: `max` is the hard cap (schema + overflow test), `soft` the default target (warnings). */
export interface TextBudget {
  soft: number;
  max: number;
}
export interface ListBudget {
  min: number;
  soft: number;
  max: number;
  item: TextBudget;
}

const words = (soft: number, max: number): TextBudget => ({ soft, max });
const list = (min: number, soft: number, max: number, item: TextBudget): ListBudget => ({ min, soft, max, item });

/** Hard content budgets per layout (word-equivalents; 1.7 CJK characters = 1 word). */
export const BUDGETS = {
  title: { title: words(10, 12), subtitle: words(10, 12), objectives: list(1, 3, 3, words(8, 10)) },
  statement: { title: words(12, 15), bullets: list(1, 3, 4, words(8, 9)), bodyTotal: words(24, 32), terms: list(0, 2, 3, words(2, 3)) },
  chart: { title: words(12, 15), takeaways: list(1, 2, 3, words(8, 9)), source: words(6, 8) },
  steps: { title: words(12, 15), problem: words(18, 24), steps: list(2, 4, 5, words(7, 8)), why: words(4, 5) },
  experiment: { title: words(12, 15), question: words(10, 14), options: list(2, 3, 4, words(3, 4)), observe: list(1, 2, 3, words(6, 7)), explain: words(14, 18) },
  quiz: { question: words(14, 20), options: list(3, 4, 4, words(5, 7)), misconception: words(8, 10), explain: words(14, 18) },
  questions: { title: words(8, 12), items: list(2, 3, 4, words(8, 10)), answer: words(4, 6) },
  summary: { title: words(12, 15), nodes: list(3, 3, 4, words(3, 4)), detail: words(6, 8) },
} as const;
