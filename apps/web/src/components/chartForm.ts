import type { ChartSpec } from "@kj/schema";

const splitPipe = (s: string) => s.split("|").map((c) => c.trim());

export function parseChartCategories(raw: string): string[] | undefined {
  const cats = splitPipe(raw).filter(Boolean);
  return cats.length ? cats : undefined;
}

export function formatChartCategories(categories?: string[]): string {
  return categories?.length ? categories.join(" | ") : "";
}

function parseDatum(cell: string): number | [number, number] | null {
  const cleaned = cell.trim().replace(/^\(|\)$/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.includes(",")) {
    const parts = cleaned.split(",").map((p) => Number(p.trim()));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return [parts[0]!, parts[1]!];
    }
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseChartSeries(raw: string): ChartSpec["series"] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = lines.slice(0, 4).map((line) => {
    const colonMatch = /^([^|:：]{1,40})[:：]\s*(.+)$/.exec(line);
    let name = "";
    let cells: string[];
    if (colonMatch) {
      name = colonMatch[1]!.trim();
      cells = splitPipe(colonMatch[2]!);
    } else {
      const parts = splitPipe(line);
      if (parts.length > 1 && parseDatum(parts[0]!) === null) {
        name = parts[0]!;
        cells = parts.slice(1);
      } else {
        cells = parts;
      }
    }
    const data = cells.map(parseDatum).filter((d): d is number | [number, number] => d !== null);
    return { name: name.slice(0, 40), data: data.length ? data : [0] };
  });
  return parsed.length ? parsed : [{ name: "", data: [0] }];
}

export function formatChartSeries(series: ChartSpec["series"]): string {
  return series
    .map((s) => {
      const values = s.data.map((d) => (Array.isArray(d) ? `${d[0]}, ${d[1]}` : String(d))).join(" | ");
      return s.name ? `${s.name}: ${values}` : values;
    })
    .join("\n");
}
