import { defineConfig, devices } from "@playwright/test";
import * as cp from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

// @ts-expect-error env is injected
const env: Record<string, any> = process.env || import.meta.env || {};

// Get Playwright version
const clientPlaywrightVersion = cp
  .execSync("npx playwright --version")
  .toString()
  .trim()
  .split(" ")[1];

// BrowserStack capabilities
const caps = {
  browser: "playwright-chromium", // or 'playwright-firefox', 'playwright-webkit'
  os: "os x",
  os_version: "mojave",
  name: "My Playwright Test",
  build: "My Build",
  "browserstack.username": env.BROWSERSTACK_USERNAME,
  "browserstack.accessKey": env.BROWSERSTACK_ACCESS_KEY,
  "browserstack.local": "true", // Add this for local testing
  "client.playwrightVersion": clientPlaywrightVersion,
};

// Generate WS endpoint
const wsEndpoint = `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!env.CI,
  /* Retry on CI only */
  retries: env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1, //env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ["html"],
    ["json", { outputFile: "./test-results/results.json" }],
    ["junit", { outputFile: "./test-results/junit.xml" }],
  ],
  /* Global test timeout */
  timeout: 60000,

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://127.0.0.1:5173",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",

    /* Take screenshot on failure */
    screenshot: "only-on-failure",

    /* Record video on failure */
    video: "retain-on-failure",

    /* Longer timeouts for worker initialization and database setup */
    actionTimeout: 30000,
    navigationTimeout: 45000,

    /* Accept that the app may continuously make requests */
    // waitForLoadState: "domcontentloaded",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "Desktop Chrome",
      use: {
        ...devices["Desktop Chrome"],
        // Ensure SharedArrayBuffer support
        launchOptions: {
          args: [
            "--enable-features=SharedArrayBuffer",
            "--disable-web-security",
            "--disable-features=VizDisplayCompositor",
          ],
        },
      },
    },

    {
      name: "Desktop Firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Firefox specific flags for SharedArrayBuffer
        launchOptions: {
          firefoxUserPrefs: {
            "javascript.options.shared_memory": true,
            "dom.postMessage.sharedArrayBuffer.withCOOP_COEP": false,
          },
        },
      },
    },

    {
      name: "Desktop Safari",
      use: { ...devices["Desktop Safari"] },
    },

    /* Mobile browsers - may have limited worker support */
    {
      name: "Mobile Chrome",
      use: {
        ...devices["Pixel 5"],
        launchOptions: {
          args: ["--enable-features=SharedArrayBuffer"],
        },
      },
    },

    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
    },

    /* Microsoft Edge - uncomment if Edge is installed */
    // {
    //   name: 'Microsoft Edge',
    //   use: {
    //     ...devices['Desktop Edge'],
    //     channel: 'msedge',
    //     launchOptions: {
    //       args: ['--enable-features=SharedArrayBuffer']
    //     }
    //   },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !env.CI,
    timeout: 120 * 1000, // 2 minutes timeout for server startup
    /* Don't wait for networkidle since the app makes continuous requests */
    // waitForResponse: () => true,
  },
});
