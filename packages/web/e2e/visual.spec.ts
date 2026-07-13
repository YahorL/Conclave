import { test, expect } from "@playwright/test";

// Pixel/visual check against the design handoff section 4a.
//
// Not run by Vitest (vitest is scoped to src/**). Run with Playwright against a
// live stack — a hub seeded with realistic data and the Vite dev server pointed
// at it. See packages/web/README.md ("End-to-end / visual check") for the seed
// recipe and the exact hub/vite commands.
//
//   npx playwright test packages/web/e2e/visual.spec.ts
//
// Compare the saved screenshot to design_handoff_conclave/screenshots/4a-black-main.png.
// (Pixel diff is a manual eyeball this step; a toMatchSnapshot baseline can be
// added once the layout is locked.)

const APP_URL = process.env.CONCLAVE_WEB_URL ?? "http://localhost:5273";

test("renders the section-4a shell with live data", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(APP_URL);

  // Wait for the chat to hydrate from the hub.
  await expect(page.getByTestId("group-chat")).toBeVisible();
  await expect(page.getByText("plan")).toBeVisible();
  await expect(page.getByText(/\$4\.82 \/ \$25/)).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/4a-black-actual.png", fullPage: false });
});
