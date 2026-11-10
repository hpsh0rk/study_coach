import { Outline, type Outline as OutlineValue } from "@kj/schema";

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyOf = (lessonId: string, versionId: string) => `kj:outline-draft:${lessonId}:${versionId}`;

export function loadOutlineDraft(storage: DraftStorage, lessonId: string, versionId: string): OutlineValue | null {
  try {
    const raw = storage.getItem(keyOf(lessonId, versionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { outline?: unknown };
    const result = Outline.safeParse(parsed.outline);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function saveOutlineDraft(storage: DraftStorage, lessonId: string, versionId: string, outline: OutlineValue): void {
  try {
    storage.setItem(keyOf(lessonId, versionId), JSON.stringify({ outline, savedAt: Date.now() }));
  } catch {
    // The in-memory edits remain available even if private browsing disables local storage.
  }
}

export function clearOutlineDraft(storage: DraftStorage, lessonId: string, versionId: string): void {
  try {
    storage.removeItem(keyOf(lessonId, versionId));
  } catch {
    // A blocked storage backend is equivalent to having no recoverable local draft.
  }
}
