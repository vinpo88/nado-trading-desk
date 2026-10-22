import { defineConfig, devices } from "@playwright/test";

const port = process.env.PORT ?? "18275";
export default defineConfig({
  testDir: "./tests", testMatch: "funds.spec.ts", workers: 1,
  timeout: 120_000, expect: { timeout: 20_000 }, reporter: "list",
  use: {
    ...devices["Desktop Chrome"], channel: process.platform === "win32" ? "msedge" : undefined,
    baseURL: `http://127.0.0.1:${port}`, trace: "off", video: "off", screenshot: "off",
    serviceWorkers: "block",
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p ${port}`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 180_000,
    env: { NADO_BUILD_DIR: ".next-funds-e2e", NADO_LIVE: "0", NADO_DEV_SEED: "0" },
  },
});
