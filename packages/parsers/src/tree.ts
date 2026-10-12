import { newId, type ChapterNode, type ParsedDocument } from "@kj/schema";

const WORDS_PER_SLIDE = 160;

function countWords(text: string): number {
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return latin + Math.ceil(cjk / 2);
}

export function pageText(doc: ParsedDocument, start: number, end: number): string {
  return doc.blocks
    .filter((b) => b.page >= start && b.page <= end && b.text)
    .map((b) => b.text)
    .join("\n");
}

/** Chapter tree from bookmarks (plan §9.2 step 4, first priority). Without bookmarks: fixed page buckets until M1a-2. */
export function buildChapterTree(doc: ParsedDocument, opts: { bucketPages?: number } = {}): ChapterNode[] {
  const toc = [...(doc.toc ?? [])].sort((a, b) => a.page - b.page);
  const nodes: ChapterNode[] = [];
  if (toc.length === 0) {
    const size = opts.bucketPages ?? 10;
    for (let start = 1, ord = 0; start <= doc.pageCount; start += size, ord++) {
      const end = Math.min(doc.pageCount, start + size - 1);
      const words = countWords(pageText(doc, start, end));
      nodes.push({ id: newId("ch"), parentId: null, ord, level: 1, title: `Pages ${start}–${end}`, pageStart: start, pageEnd: end, wordCount: words, estSlides: Math.max(1, Math.ceil(words / WORDS_PER_SLIDE)) });
    }
    return nodes;
  }

  const stack: ChapterNode[] = [];
  const siblingCount = new Map<string | null, number>();
  toc.forEach((entry, i) => {
    let end = doc.pageCount;
    for (let j = i + 1; j < toc.length; j++) {
      if (toc[j]!.level <= entry.level) {
        end = Math.max(entry.page, toc[j]!.page - (toc[j]!.page > entry.page ? 1 : 0));
        break;
      }
    }
    while (stack.length && stack[stack.length - 1]!.level >= entry.level) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1]!.id : null;
    const ord = siblingCount.get(parentId) ?? 0;
    siblingCount.set(parentId, ord + 1);
    const words = countWords(pageText(doc, entry.page, end));
    const node: ChapterNode = {
      id: newId("ch"),
      parentId,
      ord,
      level: Math.min(entry.level, stack.length + 1),
      title: entry.title,
      pageStart: entry.page,
      pageEnd: end,
      wordCount: words,
      estSlides: Math.max(1, Math.ceil(words / WORDS_PER_SLIDE)),
    };
    nodes.push(node);
    stack.push(node);
  });
  return nodes;
}
