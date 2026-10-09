// Off-camera preparation of a fresh n8n: owner account, first-run modals dismissed, and (with OPENAI_API_KEY)
// the OpenAI credential the AI Agent step uses. Env: N8N_PW, N8N_EMAIL (default demo@example.com), OPENAI_API_KEY.
import { chromium } from "playwright";

const BASE = "http://localhost:5678";
const PW = process.env.N8N_PW, EMAIL = process.env.N8N_EMAIL || "demo@example.com";
if (!PW) throw new Error("N8N_PW is required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/setup`, { waitUntil: "networkidle" });
try {
  await page.getByRole("textbox", { name: /Email/ }).waitFor({ state: "visible", timeout: 90000 });
} catch (e) {
  await page.screenshot({ path: "setup-fail.png" }); console.error("setup page:", page.url()); throw e;
}
await page.getByRole("textbox", { name: /Email/ }).fill(EMAIL);
await page.getByRole("textbox", { name: /First Name/ }).fill("Match");
await page.getByRole("textbox", { name: /Last Name/ }).fill("Awards");
await page.getByRole("textbox", { name: /Password/ }).fill(PW);
await page.locator('[data-test-id="form-submit-button"]').click();
await page.waitForURL((u) => !u.pathname.startsWith("/setup"), { timeout: 30000 });
await page.getByRole("button", { name: "Get started" }).click({ timeout: 15000 }).catch(() => {});
await page.goto(`${BASE}/workflow/new`);
await page.getByRole("button", { name: "Skip" }).click({ timeout: 15000 }).catch(() => {});

if (process.env.OPENAI_API_KEY) {
  // The key goes straight into n8n's encrypted credential store; it is never printed or written to disk here.
  const r = await page.request.post(`${BASE}/rest/credentials`, {
    data: { name: "OpenAI account", type: "openAiApi", data: { apiKey: process.env.OPENAI_API_KEY } },
  });
  console.log("OpenAI credential:", r.ok() ? "created" : `HTTP ${r.status()}`);
}
console.log("setup done");
await browser.close();
