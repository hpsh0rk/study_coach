import { describe, expect, it, vi } from "vitest";
import { ChartSpec, type Slide, type Unverified } from "@kj/schema";
import { validateWidget } from "@kj/widgets";
import { formatChartCategories, formatChartSeries, parseChartCategories, parseChartSeries } from "../src/components/chartForm.ts";
import {
  activeUnverified,
  loadDismissedUnverified,
  saveDismissedUnverified,
  unverifiedItemKey,
} from "../src/components/Unverified.tsx";
import {
  buildGeneratePayload,
  generateMissingSlides,
  generateSlideWithLock,
} from "../src/pages/wizard/slideGeneration.ts";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("structured chart form helpers", () => {
  it("parses and formats category bar/line charts and [x, y] scatter series cleanly", () => {
    const cats = parseChartCategories("空气 Air | 水 Water | 钢铁 Steel");
    expect(cats).toEqual(["空气 Air", "水 Water", "钢铁 Steel"]);
    expect(formatChartCategories(cats)).toBe("空气 Air | 水 Water | 钢铁 Steel");
    expect(parseChartCategories("   ")).toBeUndefined();

    const barSeries = parseChartSeries("声速: 340 | 1480 | 5960\n对照：330 | 1500 | 5900");
    expect(barSeries).toEqual([
      { name: "声速", data: [340, 1480, 5960] },
      { name: "对照", data: [330, 1500, 5900] },
    ]);
    const spec = ChartSpec.parse({
      kind: "chart",
      type: "bar",
      xLabel: "介质",
      yLabel: "v / (m/s)",
      categories: cats,
      series: barSeries,
    });
    expect(validateWidget(spec)).toEqual([]);
    expect(parseChartSeries(formatChartSeries(barSeries))).toEqual(barSeries);

    // Numeric series names ("2025: 10 | 20") and nameless series ("10 | 20") and scatter pairs ("甲车: 0,0 | 1.5, 30")
    expect(parseChartSeries("2025: 10 | 20")).toEqual([{ name: "2025", data: [10, 20] }]);
    expect(parseChartSeries("10 | 20 | 30")).toEqual([{ name: "", data: [10, 20, 30] }]);
    const scatter = parseChartSeries("甲车: 0, 0 | 1.5, 30 | (3, 60)");
    expect(scatter).toEqual([
      {
        name: "甲车",
        data: [
          [0, 0],
          [1.5, 30],
          [3, 60],
        ],
      },
    ]);
    expect(
      validateWidget(
        ChartSpec.parse({
          kind: "chart",
          type: "scatter",
          xLabel: "t / s",
          yLabel: "s / m",
          series: scatter,
        }),
      ),
    ).toEqual([]);
  });
});

describe("dismissible 待核实 localStorage persistence", () => {
  const items: Unverified[] = [
    { kind: "number", text: "343", detail: "not found" },
    { kind: "formula", text: "T = 1/f", detail: "formula not found" },
  ];

  it("persists dismissed items per lesson + slide and filters active items without leaking across slides", () => {
    const store = memoryStorage();
    expect(loadDismissedUnverified(store, "les_1", "sl_1").size).toBe(0);
    expect(activeUnverified(items, new Set())).toHaveLength(2);

    const k1 = unverifiedItemKey(items[1]!);
    const next = new Set([k1]);
    saveDismissedUnverified(store, "les_1", "sl_1", next);

    const reloaded = loadDismissedUnverified(store, "les_1", "sl_1");
    expect(reloaded.has(k1)).toBe(true);
    expect(activeUnverified(items, reloaded)).toEqual([items[0]]);
    // Another slide on the same lesson stays untouched
    expect(loadDismissedUnverified(store, "les_1", "sl_2").size).toBe(0);

    // Restoring removes key from storage
    saveDismissedUnverified(store, "les_1", "sl_1", new Set());
    expect(loadDismissedUnverified(store, "les_1", "sl_1").size).toBe(0);
  });
});

describe("steered regeneration payload & AbortController stop generation", () => {
  it("builds generate payload with trimmed instruction (<= 200 chars) only when provided", () => {
    expect(buildGeneratePayload(false)).toEqual({ regenerate: false });
    expect(buildGeneratePayload(true, "   ")).toEqual({ regenerate: true });
    expect(buildGeneratePayload(true, "  换一组数字  ")).toEqual({ regenerate: true, instruction: "换一组数字" });
    expect(buildGeneratePayload(true, "x".repeat(250)).instruction?.length).toBe(200);
  });

  it("stops batch slide generation cleanly via AbortSignal without marking aborted slides as failed", async () => {
    const ac = new AbortController();
    const started: string[] = [];
    const failed: string[] = [];
    const running = new Set<string>();

    const fakeSlide = (id: string): Slide => ({
      id: `sl_${id}`,
      specId: id,
      outlineVersionId: "ov_1",
      layout: "statement",
      pageType: "concept",
      minutes: 3,
      content: { layout: "statement", title: id, bullets: ["a"], visual: { kind: "placeholder", hint: "" }, terms: [] },
      notes: "",
      sources: [],
      warnings: [],
      unverified: [],
      canUndo: false,
    });

    const specs = Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, pageType: "concept" as const }));
    const runPromise = generateMissingSlides(
      specs,
      new Set(),
      (specId) =>
        generateSlideWithLock(specId, false, {
          signal: ac.signal,
          request: (id, _regen, signal) => {
            started.push(id);
            return new Promise<Slide>((resolve, reject) => {
              if (id === "s1") {
                resolve(fakeSlide(id));
                return;
              }
              signal?.addEventListener("abort", () => {
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              });
            });
          },
          onStart: (id) => running.add(id),
          onSlide: vi.fn(),
          onError: (id) => failed.push(id),
          onDone: (id) => running.delete(id),
        }),
      { signal: ac.signal },
    );

    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await runPromise;

    // Only initial wave started; s6 was never launched; zero aborted slides recorded as errors; running cleared.
    expect(started).not.toContain("s6");
    expect(failed).toEqual([]);
    expect(running.size).toBe(0);
  });
});
