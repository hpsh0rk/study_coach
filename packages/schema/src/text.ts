const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

/**
 * Word-equivalents for mixed Chinese/English text: Latin words count 1 each, and
 * 1.7 CJK characters count as one word (pedagogy-rules §4).
 */
export function countWords(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = text.replace(CJK, " ").match(/[A-Za-z0-9][A-Za-z0-9'’\-.]*/g)?.length ?? 0;
  return Math.round(latin + cjk / 1.7);
}

export function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}
