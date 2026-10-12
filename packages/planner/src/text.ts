/** Sentences long enough to teach from; CJK and Latin punctuation both split. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 260);
}

/** First `max` words of a sentence without trailing punctuation (CJK: max × 1.7 characters). */
export function shorten(sentence: string, max: number): string {
  const s = sentence.replace(/[.!?。！？;；,，:：]+$/, "").trim();
  if (/[\u3400-\u9fff]/.test(s)) {
    const limit = Math.floor(max * 1.7);
    return s.length > limit ? s.slice(0, limit) : s;
  }
  const words = s.split(/\s+/);
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "");
}
