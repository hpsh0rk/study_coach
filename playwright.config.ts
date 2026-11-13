import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8788);
const baseURL = `http://127.0.0.1:${PORT}`;
const authenticated = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 }, storageState: "playwright/.auth/admin.json" };

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure", viewport: { width: 1280, height: 720 }, locale: "zh-CN" },
  projects: [
    { name: "overflow", testMatch: /[\\/]overflow\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
    { name: "auth", testMatch: /[\\/]auth\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
    { name: "lesson", testMatch: /[\\/]lesson\.spec\.ts$/, dependencies: ["auth"], use: authenticated },
    { name: "textbook", testMatch: /[\\/]textbook\.spec\.ts$/, dependencies: ["lesson"], use: authenticated },
    { name: "admin", testMatch: /[\\/]admin\.spec\.ts$/, dependencies: ["textbook"], use: authenticated },
    { name: "walkthrough", testMatch: /[\\/]walkthrough-ux\.spec\.ts$/, dependencies: ["admin"], use: authenticated },
    { name: "bundle", testMatch: /[\\/]bundle-offline\.spec\.ts$/, dependencies: ["walkthrough"], use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: "bash scripts/e2e-server.sh",
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
