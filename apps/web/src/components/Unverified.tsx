import { createContext, useState } from "react";
import type { Unverified } from "@kj/schema";

const KIND: Record<Unverified["kind"], string> = { number: "数字 Number", formula: "公式 Formula", calc: "计算 Calculation", source: "页码 Source page" };

/** Texts flagged 待核实 on the slide being edited; matching fields are outlined in yellow. */
export const FlagContext = createContext<string[]>([]);

export const isFlagged = (flags: string[], value: string) => flags.some((f) => f && value.includes(f));

export const unverifiedItemKey = (u: Pick<Unverified, "kind" | "text">) => `${u.kind}:${u.text}`;

const storageKey = (lessonId: string, slideId: string) => `kj-dismissed-unverified:v1:${lessonId}:${slideId}`;

export function loadDismissedUnverified(storage: Pick<Storage, "getItem"> | null | undefined, lessonId: string, slideId: string): Set<string> {
  if (!storage || !lessonId || !slideId) return new Set();
  try {
    const raw = storage.getItem(storageKey(lessonId, slideId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveDismissedUnverified(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, lessonId: string, slideId: string, keys: ReadonlySet<string>): void {
  if (!storage || !lessonId || !slideId) return;
  try {
    const k = storageKey(lessonId, slideId);
    if (keys.size === 0) storage.removeItem(k);
    else storage.setItem(k, JSON.stringify([...keys]));
  } catch {
    // Quota or private mode: works in-memory for the current view.
  }
}

export function activeUnverified(items: readonly Unverified[] | undefined, dismissed: ReadonlySet<string>): Unverified[] {
  if (!items?.length) return [];
  if (!dismissed.size) return [...items];
  return items.filter((u) => !dismissed.has(unverifiedItemKey(u)));
}

export function UnverifiedBox({
  items,
  sources,
  onSourceClick,
  dismissed,
  onDismiss,
  onRestore,
}: {
  items: Unverified[];
  sources?: number[];
  onSourceClick?: (no: number) => void;
  dismissed?: ReadonlySet<string>;
  onDismiss?: (item: Unverified) => void;
  onRestore?: (item: Unverified) => void;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  if (!items.length) return null;
  const hiddenKeys = dismissed ?? new Set<string>();
  const active = activeUnverified(items, hiddenKeys);
  const ignored = items.filter((u) => hiddenKeys.has(unverifiedItemKey(u)));

  if (!active.length) {
    return (
      <div className="unverified-dismissed small muted" data-testid="unverified-dismissed-bar">
        <span>已核实忽略 {ignored.length} 处提示 · {ignored.length} verified</span>{" "}
        <button type="button" className="link" onClick={() => setShowDismissed((v) => !v)} data-testid="toggle-dismissed-unverified">
          {showDismissed ? "收起 Hide" : "查看 / 恢复 Show"}
        </button>
        {showDismissed && (
          <ul className="unverified-ignored-list">
            {ignored.map((u, i) => (
              <li key={i} className="unverified-item-row">
                <span>
                  <span className="unverified-kind">{KIND[u.kind]}</span> <code>{u.text}</code>
                  {u.detail && <span className="muted small"> · {u.detail}</span>}
                </span>
                {onRestore && (
                  <button type="button" className="btn small ghost" onClick={() => onRestore(u)} data-testid="restore-unverified">
                    恢复 Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="unverified-box" role="note" data-testid="unverified">
      <div className="row between wrap">
        <b>待核实 {active.length} 处 · Check against the source</b>
        <div className="row">
          {ignored.length > 0 && (
            <button type="button" className="link small" onClick={() => setShowDismissed((v) => !v)} data-testid="toggle-dismissed-unverified">
              {showDismissed ? `收起已忽略（${ignored.length}）` : `已忽略 ${ignored.length} 处 · 查看`}
            </button>
          )}
          {onDismiss && active.length > 1 && (
            <button
              type="button"
              className="btn small ghost"
              onClick={() => active.forEach((item) => onDismiss(item))}
              data-testid="dismiss-all-unverified"
            >
              全部已核实 ✓
            </button>
          )}
        </div>
      </div>
      <p className="small">这些数字或公式在引用的教材页中没有找到，或计算对不上。请对照原文核实后再上课。</p>
      <ul>
        {active.map((u, i) => (
          <li key={i} className="unverified-item-row">
            <span>
              <span className="unverified-kind">{KIND[u.kind]}</span> <code>{u.text}</code>
              {u.detail && <span className="muted small"> · {u.detail}</span>}
            </span>
            {onDismiss && (
              <button type="button" className="btn small ghost" onClick={() => onDismiss(u)} data-testid="dismiss-unverified" title="我已对照原书核实无误，隐藏这条提示">
                已核实 ✓
              </button>
            )}
          </li>
        ))}
      </ul>
      {showDismissed && ignored.length > 0 && (
        <ul className="unverified-ignored-list small muted">
          {ignored.map((u, i) => (
            <li key={i} className="unverified-item-row">
              <span>
                <span className="unverified-kind">{KIND[u.kind]}</span> <code>{u.text}</code>
              </span>
              {onRestore && (
                <button type="button" className="btn small ghost" onClick={() => onRestore(u)} data-testid="restore-unverified">
                  恢复 Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sources && sources.length > 0 && onSourceClick && (
        <div className="row small wrap">
          对照原文 Open source:
          {sources.map((no) => (
            <button key={no} type="button" className="btn small ghost" onClick={() => onSourceClick(no)}>
              p.{no}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UnverifiedBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="badge-unverified" title="数字/公式待核实 · numbers or formulas to check" data-testid="unverified-badge">
      待核实 {count}
    </span>
  );
}
