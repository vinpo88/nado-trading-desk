import { defineConfig, devices } from "@playwright/test";

// A dedicated server/build directory and disposable browser context keep this
// read-only pilot test away from any operator's running console and vault.
const port = "18276";
export default defineConfig({
  testDir: "./tests", testMatch: "trade-test.spec.ts", workers: 1,
  fullyParallel: false, retries: 0, forbidOnly: !!process.env.CI,
  timeout: 180_000, expect: { timeout: 20_000 }, reporter: "list",
  outputDir: "test-results/trade-test",
  use: {
    ...devices["Desktop Chrome"], channel: process.platform === "win32" ? "msedge" : undefined,
    baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1100 },
    locale: "zh-CN", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" },
    actionTimeout: 20_000, navigationTimeout: 90_000,
    trace: "off", video: "off", screenshot: "off", serviceWorkers: "block",
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p ${port}`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 180_000,
    env: { NADO_BUILD_DIR: ".next-trade-test-e2e", NADO_LIVE: "0", NADO_DEV_SEED: "0" },
  },
});
