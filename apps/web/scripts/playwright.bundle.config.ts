import * as path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PORT = Number(process.env.E2E_PORT ?? 8788);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: path.join(ROOT, "e2e"),
  outputDir: path.join(ROOT, "test-results/playwright-bundle"),
  testMatch: /[\\/]bundle-offline\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure", viewport: { width: 1280, height: 720 }, locale: "zh-CN" },
  projects: [
    {
      name: "bundle-offline",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: "bash scripts/e2e-server.sh",
    cwd: ROOT,
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
