// One continuous Playwright take of the n8n demo for the Creator Portal review, against a throwaway n8n on
// localhost:5678 (prepared by setup.mjs). Adapted from the DNS Doctor node's recorder.
// Env: N8N_PW (owner password), N8N_EMAIL (default demo@example.com), DRY=1 (no video, screenshot every step into
// shots/, skip the install when already present), SKIP_TO_AGENT=1 (only the AI Agent step), NO_CHAT=1 (stop before
// the chat, e.g. without an OpenAI credential).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5678";
const PW = process.env.N8N_PW, EMAIL = process.env.N8N_EMAIL || "demo@example.com", DRY = !!process.env.DRY;
const NAICS = "541511"; // Custom Computer Programming Services
if (!PW) throw new Error("N8N_PW is required");
const pace = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync("videos", { recursive: true }); mkdirSync("shots", { recursive: true });
let n = 0;
const shot = async (page, name) => { if (DRY) await page.screenshot({ path: `shots/${String(++n).padStart(2, "0")}-${name}.png` }); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ...(DRY ? {} : { recordVideo: { dir: "videos", size: { width: 1600, height: 1000 } } }),
});
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

async function pick(param, option) {
  await page.locator(`[data-test-id="parameter-input-${param}"] input`).first().click();
  await pace(300);
  await page.getByRole("option", { name: option, exact: true }).first().click();
  await pace(500);
}
async function fill(param, value) {
  // One fill, then re-check: n8n re-mounts some inputs on the first keystroke, so per-key typing can lose characters.
  const field = page.locator(`[data-test-id="parameter-input-${param}"] [data-test-id="parameter-input-field"], [data-test-id="parameter-input-${param}"] input`).first();
  await field.click(); await pace(300);
  await field.fill(value); await pace(500);
  if ((await field.inputValue()) !== value) { await field.fill(value); await pace(400); }
}
async function newWorkflow() {
  // An empty instance shows a "Build a workflow" card; once a workflow exists, a "Create workflow" button.
  const card = page.getByText("Build a workflow", { exact: true });
  if (await card.isVisible().catch(() => false)) await card.click();
  else await page.getByRole("button", { name: "Create workflow" }).first().click();
  await pace(1200);
}
async function execute(waitFor) {
  await page.locator('[data-test-id="node-execute-button"]').click();
  await page.getByText(waitFor).first().waitFor({ state: "visible", timeout: 120000 });
  await pace(1500);
}

try {
// ── Sign in ──
await page.goto(`${BASE}/signin`);
await page.getByRole("textbox", { name: /Email/ }).fill(EMAIL);
await page.getByRole("textbox", { name: /Password/ }).fill(PW);
await page.locator('[data-test-id="form-submit-button"]').click();
await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30000 });
await pace(1500); await shot(page, "signed-in");

if (process.env.SKIP_TO_AGENT !== "1") {
// ── 1. Install the node from npm (the submitted version) ──
// In-app navigation only from here on: a hard page load paints white for a second or two, which reads as a cut.
await page.getByRole("menuitem", { name: "Settings" }).click();
await pace(1000);
await page.getByRole("menuitem", { name: "Community nodes" }).click();
await pace(1500);
const installed = await page.getByText("n8n-nodes-matchawards").first().isVisible().catch(() => false);
if (!installed) {
  await page.getByRole("button", { name: /Install/ }).first().click();
  await page.locator('[data-test-id="package-name-input"]').pressSequentially("n8n-nodes-matchawards", { delay: 60 });
  await pace(600);
  await page.locator('[data-test-id="user-agreement-checkbox"]').check();
  await pace(600);
  await page.locator('[data-test-id="install-community-package-button"]').click();
  await page.getByText(/1 node/).first().waitFor({ state: "visible", timeout: 180000 });
} else if (!DRY) { throw new Error("node already installed: uninstall it before the real take"); }
await pace(2500); await shot(page, "installed");

// ── 2. New workflow: manual trigger → MatchAwards · Search contracts (no credential needed) ──
await page.getByText("Settings", { exact: true }).first().click(); // the settings rail's back control
await pace(800);
await page.getByRole("menuitem", { name: "Overview" }).click();
await pace(800);
await newWorkflow();
await page.locator('[data-test-id="canvas-plus-button"]').click();
await page.getByText("Trigger manually").first().click();
await pace(800);
await page.locator('[data-test-id="node-creator-plus-button"]').click();
await page.locator('[data-test-id="node-creator-search-bar"]').pressSequentially("MatchAwards", { delay: 70 });
await pace(800);
await page.locator('[data-test-id="node-creator-item-name"]').filter({ hasText: /^MatchAwards$/ }).first().click();
await pace(1500); await shot(page, "actions");
await page.getByText("Search contracts", { exact: true }).first().click();
await pace(1500); await shot(page, "node-details");
await fill("naics", NAICS);
await pick("level", "Federal"); // federal notices carry points of contact, shown by Get below
await fill("limit", "5");
await execute(/5 items/);
await pace(2000); await shot(page, "contracts-output");

// ── 3. The other resources in the same node: grants, then jobs ──
await pick("resource", "Grant");
await execute(/items?/);
await pace(2500); await shot(page, "grants-output");
await pick("resource", "Job");
await execute(/items?/);
await pace(2500); await shot(page, "jobs-output");
await pick("resource", "Contract");
await execute(/5 items/);
await page.keyboard.press("Escape");
await pace(1000);

// ── 4. Get: the full record (description and points of contact) of each search result ──
await page.locator('[data-test-id="canvas-handle-plus"]').last().click();
await page.locator('[data-test-id="node-creator-search-bar"]').pressSequentially("MatchAwards", { delay: 70 });
await pace(800);
await page.locator('[data-test-id="node-creator-item-name"]').filter({ hasText: /^MatchAwards$/ }).first().click();
await pace(800);
await page.getByText("Get a contract", { exact: true }).first().click();
await pace(1200);
// An expression: inserted as text (typed braces auto-close), after which n8n swaps the input for its expression editor.
await page.locator('[data-test-id="parameter-input-id"] input, [data-test-id="parameter-input-id"] [data-test-id="parameter-input-field"]').first().click();
await pace(300);
await page.keyboard.insertText("{{ $json.id }}");
await pace(1000);
await execute(/contacts/);
await page.getByRole("radio", { name: "Schema" }).last().click(); // the Table view clips the description
await pace(4000); await shot(page, "get-output");
await page.keyboard.press("Escape");
await pace(800);
await page.getByRole("button", { name: /^Save/ }).first().click().catch(() => {});
await pace(800);
}

// ── 5. As an AI Agent tool: chat trigger → AI Agent → OpenAI + MatchAwards Tool → chat ──
await page.getByRole("menuitem", { name: "Overview" }).click();
await pace(800);
await page.getByRole("button", { name: /Leave without saving|Leave/ }).click({ timeout: 3000 }).catch(() => {});
await pace(800);
await newWorkflow();
await page.locator('[data-test-id="canvas-plus-button"]').click();
await page.getByText("On chat message").first().click();
await pace(1000);
await page.keyboard.press("Escape"); // close the trigger's NDV if it opened
await pace(600);
await page.locator('[data-test-id="node-creator-plus-button"]').click();
await page.locator('[data-test-id="node-creator-search-bar"]').pressSequentially("AI Agent", { delay: 70 });
await pace(800);
await page.getByText(/^AI Agent/).first().click();
await pace(1200);
await page.keyboard.press("Escape");
await pace(600);
await page.locator('[data-test-id="canvas-node-input-handle"][data-connection-type="ai_languageModel"] [data-test-id="canvas-handle-plus"]').click();
await page.getByText("OpenAI Chat Model", { exact: true }).first().click();
await pace(1500); await shot(page, "openai-model");
await page.keyboard.press("Escape");
await pace(600);
await page.locator('[data-test-id="canvas-node-input-handle"][data-connection-type="ai_tool"] [data-test-id="canvas-handle-plus"]').click();
await page.locator('[data-test-id="node-creator-search-bar"]').pressSequentially("MatchAwards", { delay: 70 });
await pace(800);
await page.getByText(/^MatchAwards Tool/).first().click();
await pace(1500);
// NAICS, Limit: let the model fill them from the chat message.
await page.locator('[data-test-id="parameter-input-naics"]').locator("..").locator('[data-test-id="from-ai-override-button"]').first().click()
  .catch(() => page.locator('[data-test-id="from-ai-override-button"]').first().click());
await pace(1500); await shot(page, "tool-configured");
await page.keyboard.press("Escape");
await pace(800); await shot(page, "agent-canvas");
if (!process.env.NO_CHAT) {
  await page.locator('[data-test-id="workflow-chat-button"]').click();
  await pace(1200); await shot(page, "chat-open");
  const chatInput = page.getByPlaceholder(/Type message/);
  await chatInput.click();
  await chatInput.fill("Find three open federal software development contracts (NAICS 541511) and give me their titles, agencies, deadlines and links.");
  await pace(600);
  await page.keyboard.press("Enter");
  // the agent calls the tool, then answers
  await page.getByText(/Running for/).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  await page.getByText(/Running for/).first().waitFor({ state: "hidden", timeout: 240000 }).catch(() => {});
  await pace(7000); await shot(page, "chat-answer");
}
await pace(1500);
} catch (e) {
  await page.screenshot({ path: "shots/fail.png" }).catch(() => {});
  console.error("FAILED at:", e.message);
  await page.close(); await ctx.close(); await browser.close();
  process.exit(1);
}
const video = DRY ? null : await page.video()?.path();
await page.close(); await ctx.close(); await browser.close();
console.log("DONE", video ?? "(dry run, see shots/)");
