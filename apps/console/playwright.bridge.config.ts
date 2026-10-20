import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Pure policy/bridge mocks: no browser process, real vault, network or app server.
export default defineConfig({
  ...base,
  testMatch: "wallet-connect.spec.ts",
  grep: /\b(policy|bridge):/,
  webServer: undefined,
  outputDir: "./test-results/bridge",
});
