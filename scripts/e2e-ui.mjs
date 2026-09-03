import puppeteer from "puppeteer-core";
import fs from "fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const INBOX = "./dev-smtp-inbox.jsonl";

function readLastOtp(email) {
  const lines = fs.readFileSync(INBOX, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = JSON.parse(lines[i]);
    if (rec.to?.some((t) => t.includes(email)) && rec.otp) return rec.otp;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uiLogin(page, email, password) {
  await page.goto("http://localhost:5173/login", { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);
  // fill email + password
  const inputs = await page.$$("input");
  let emailInput = null, passInput = null;
  for (const inp of inputs) {
    const type = await inp.evaluate((el) => el.type + "|" + el.placeholder + "|" + el.name);
    if (/email/i.test(type)) emailInput = inp;
    if (/password/i.test(type)) passInput = inp;
  }
  if (!emailInput || !passInput) throw new Error("login inputs not found; found=" + inputs.length);
  await emailInput.evaluate((el) => (el.value = ""));
  await emailInput.type(email, { delay: 10 });
  await passInput.evaluate((el) => (el.value = ""));
  await passInput.type(password, { delay: 10 });
  await page.screenshot({ path: "./ui-shots/login-filled.png" });
  // submit
  const btn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => /sign in|login|continue/i.test(b.textContent || ""));
  });
  await btn.asElement().click();
  // wait for OTP step: six maxLength=1 inputs
  let digitInputs = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    digitInputs = await page.$$("input[maxlength='1']");
    if (digitInputs.length >= 6) break;
  }
  if (digitInputs.length < 6) throw new Error("OTP step never appeared (rate-limited or login failed)");
  const otp = readLastOtp(email);
  if (!otp) throw new Error("no otp in inbox");
  for (let i = 0; i < 6; i++) {
    await digitInputs[i].type(otp[i], { delay: 40 });
  }
  await page.screenshot({ path: "./ui-shots/otp-filled.png" });
  // wait for verify button to become enabled then click
  await sleep(300);
  const verifyBtn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => !b.disabled && /verify/i.test(b.textContent || ""));
  });
  if (verifyBtn.asElement()) await verifyBtn.asElement().click();
  // wait for redirect to dashboard
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (page.url().includes("/dashboard")) break;
  }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

fs.mkdirSync("./ui-shots", { recursive: true });
const results = [];

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

  // ── Desktop login flow as org-admin ──
  results.push("=== UI: LOGIN FLOW (org-admin, desktop 1280px) ===");
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await uiLogin(page, "audit-orgadmin@test.local", "AuditOrg#123");
    await sleep(2000);
    const url = page.url();
    results.push(`after OTP login url=${url} ${url.includes("/dashboard") ? "✅ redirected to dashboard" : "❌ not on dashboard"}`);
    await page.screenshot({ path: "./ui-shots/dashboard-orgadmin.png" });

    // ── Templates page (previously crashed) as ADMIN later; first org templates page ──
    await page.goto("http://localhost:5173/org/templates", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    const tplText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    results.push(`org/templates loaded: ${tplText.includes("Template") ? "✅ renders" : "⚠️ unexpected content"} | url=${page.url()}`);
    await page.screenshot({ path: "./ui-shots/org-templates.png" });

    // leaves page
    await page.goto("http://localhost:5173/org/leaves", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1500);
    results.push(`org/leaves loaded: ${(await page.evaluate(() => document.body.innerText.length)) > 100 ? "✅" : "⚠️"} url=${page.url()}`);
    await page.screenshot({ path: "./ui-shots/org-leaves.png" });

    // logout via UI? use settings page check instead
  } catch (e) {
    results.push("❌ org-admin UI flow failed: " + e.message);
  }

  // ── Admin login + previously-crashing admin templates page ──
  results.push("\n=== UI: ADMIN TEMPLATES PAGE (previous runtime crash) ===");
  const page2 = await browser.newPage();
  const err2 = [];
  page2.on("pageerror", (err) => err2.push(err.message));
  page2.on("console", (m) => { if (m.type() === "error") err2.push(m.text()); });
  await page2.setViewport({ width: 1280, height: 900 });
  try {
    await uiLogin(page2, "audit-admin@test.local", "AuditAdmin#123");
    await sleep(1500);
    await page2.goto("http://localhost:5173/admin/templates", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    const bodyText = await page2.evaluate(() => document.body.innerText.slice(0, 400));
    const crashed = err2.some((e) => /is not a function|Cannot read propert/i.test(e));
    results.push(`admin/templates: crashed=${crashed ? "❌ YES" : "✅ NO"} | text sample="${bodyText.replace(/\n/g, " ").slice(0, 120)}"`);
    await page2.screenshot({ path: "./ui-shots/admin-templates.png" });

    // activity logs page with filters
    await page2.goto("http://localhost:5173/admin/activity-logs", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    results.push(`admin/activity-logs rendered rows: ${await page2.evaluate(() => document.querySelectorAll("table tbody tr").length)}`);
    await page2.screenshot({ path: "./ui-shots/admin-activity.png" });
  } catch (e) {
    results.push("❌ admin UI flow failed: " + e.message);
  }

  // ── Mobile viewport checks (375px) ──
  results.push("\n=== UI: MOBILE VIEWPORT 375px ===");
  const m = await browser.newPage();
  await m.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  try {
    await uiLogin(m, "audit-member@test.local", "AuditMember#123");
    await sleep(1500);
    for (const path of ["/dashboard", "/leaves", "/requests"]) {
      await m.goto("http://localhost:5173" + path, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(1800);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      results.push(`mobile ${path}: horizontal overflow=${overflow}px ${overflow > 5 ? "⚠️ OVERFLOW" : "✅ fits"} url-ok=${m.url().includes(path)}`);
      await m.screenshot({ path: `./ui-shots/mobile${path.replace(/\//g, "-")}.png` });
    }
  } catch (e) {
    results.push("❌ mobile flow failed: " + e.message);
  }

  results.push("\nconsole/page errors captured: " + (consoleErrors.length + err2.length));
  for (const e of [...consoleErrors, ...err2].slice(0, 8)) results.push("  " + e.slice(0, 160));
} finally {
  await browser.close();
}

fs.writeFileSync("./e2e-ui-results.txt", results.join("\n"));
console.log(results.join("\n"));
