import { describe, expect, it } from "vitest";
import { SLOT_SCHEMAS } from "../src/index.ts";
import { CLASSROOM_FIXTURES, classroomFixtureCells } from "../src/classroom-fixtures.ts";

describe("classroom fixture matrix", () => {
  it("contains one Chinese and one English lesson with unique slide ids", () => {
    expect(CLASSROOM_FIXTURES.map((fixture) => fixture.params.language)).toEqual(expect.arrayContaining(["en", "zh"]));
    const cells = classroomFixtureCells();
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length);
  });

  it("keeps every replayed slide within its semantic slot budget", () => {
    for (const cell of classroomFixtureCells()) {
      const parsed = SLOT_SCHEMAS[cell.layout].safeParse(cell.content);
      expect(parsed.success, `${cell.id}: ${parsed.error?.issues.map((issue) => issue.message).join("; ")}`).toBe(true);
    }
  });
});
