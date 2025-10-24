import { test, expect } from "@playwright/test";

test("BrowserStack can access local app", async ({ page }) => {
  test.setTimeout(60000);
  page.on("console", (msg) =>
    console.log("[PAGE console]", msg.type(), msg.text()),
  );
  page.on("pageerror", (err) =>
    console.log("[PAGE error]", err.stack || err.message),
  );
  page.on("response", (res) => {
    // log document responses and any 5xx/4xx
    if (res.request().resourceType() === "document" || res.status() >= 400) {
      console.log(
        "[PAGE response]",
        res.status(),
        res.request().method(),
        res.url(),
      );
    }
  });
  console.log("test running");
  await page.goto("http://localhost:5173", {
    waitUntil: "load",
    timeout: 45000,
  });
  console.log("page loaded");
  await page.waitForSelector("body", { timeout: 45000 });
  console.log("body loaded");
  await expect(page.locator("body")).toBeVisible();
});
