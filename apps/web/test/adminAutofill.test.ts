import * as fs from "node:fs";
import * as path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsersPanel } from "../src/pages/admin/UsersTab.tsx";

const ADMIN_DIR = path.resolve(new URL("../src/pages/admin", import.meta.url).pathname);

describe("admin secret input autofill prevention", () => {
  it("marks every password/API-key input in admin tabs with autoComplete=\"new-password\" instead of \"off\"", () => {
    const files = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".tsx"));
    const passwordInputs: { file: string; tag: string }[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(ADMIN_DIR, file), "utf8");
      for (const m of src.matchAll(/<input\b[\s\S]*?\/>/g)) {
        if (/\btype="password"/.test(m[0])) passwordInputs.push({ file, tag: m[0] });
      }
    }
    expect(passwordInputs.length).toBeGreaterThanOrEqual(4);
    for (const { file, tag } of passwordInputs) {
      expect(tag, `${file}: ${tag}`).toContain('autoComplete="new-password"');
      expect(tag, `${file}: ${tag}`).not.toContain('autoComplete="off"');
    }

    const usersHtml = renderToStaticMarkup(createElement(UsersPanel));
    expect(usersHtml).toMatch(/<input(?=[^>]*\bname="new-password")(?=[^>]*\bautocomplete="new-password")[^>]*>/i);
  });
});
