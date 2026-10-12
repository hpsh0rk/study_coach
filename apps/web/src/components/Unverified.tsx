import { createContext } from "react";
import type { Unverified } from "@kj/schema";

const KIND: Record<Unverified["kind"], string> = { number: "数字 Number", formula: "公式 Formula", calc: "计算 Calculation" };

/** Texts flagged 待核实 on the slide being edited; matching fields are outlined in yellow. */
export const FlagContext = createContext<string[]>([]);

export const isFlagged = (flags: string[], value: string) => flags.some((f) => f && value.includes(f));

export function UnverifiedBox({ items, sources, onSourceClick }: { items: Unverified[]; sources?: number[]; onSourceClick?: (no: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="unverified-box" role="note" data-testid="unverified">
      <b>待核实 {items.length} 处 · Check against the source</b>
      <p className="small">这些数字或公式在引用的教材页中没有找到，或计算对不上。请对照原文核实后再上课。</p>
      <ul>
        {items.map((u, i) => (
          <li key={i}>
            <span className="unverified-kind">{KIND[u.kind]}</span> <code>{u.text}</code>
            {u.detail && <span className="muted small"> · {u.detail}</span>}
          </li>
        ))}
      </ul>
      {sources && sources.length > 0 && onSourceClick && (
        <div className="row small">
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
