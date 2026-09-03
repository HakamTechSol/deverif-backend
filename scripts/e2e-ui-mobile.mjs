import puppeteer from "puppeteer-core";
import fs from "fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const INBOX = "./dev-smtp-inbox.jsonl";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLastOtp(email) {
  const lines = fs.readFileSync(INBOX, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = JSON.parse(lines[i]);
    if (rec.to?.some((t) => t.includes(email)) && rec.otp) return rec.otp;
  }
  return null;
}

async function uiLogin(page, email, password) {
  await page.goto("http://localhost:5173/login", { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);
  const inputs = await page.$$("input");
  let emailInput = null, passInput = null;
  for (const inp of inputs) {
    const type = await inp.evaluate((el) => el.type + "|" + el.placeholder + "|" + el.name);
    if (/email/i.test(type)) emailInput = inp;
    if (/password/i.test(type)) passInput = inp;
  }
  await emailInput.evaluate((el) => (el.value = ""));
  await emailInput.type(email, { delay: 10 });
  await passInput.evaluate((el) => (el.value = ""));
  await passInput.type(password, { delay: 10 });
  const btn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => /sign in|login|continue/i.test(b.textContent || ""));
  });
  await btn.asElement().click();
  let digitInputs = [];
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    digitInputs = await page.$$("input[maxlength='1']");
    if (digitInputs.length >= 6) break;
  }
  if (digitInputs.length < 6) throw new Error("OTP step never appeared");
  const otp = readLastOtp(email);
  for (let i = 0; i < 6; i++) await digitInputs[i].type(otp[i], { delay: 40 });
  await sleep(300);
  const verifyBtn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => !b.disabled && /verify/i.test(b.textContent || ""));
  });
  if (verifyBtn.asElement()) await verifyBtn.asElement().click();
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (page.url().includes("/dashboard")) break;
  }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
try {
  const m = await browser.newPage();
  await m.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await uiLogin(m, "audit-member@test.local", "AuditMember#123");
  results.push(`mobile login -> ${m.url()} ${m.url().includes("/dashboard") ? "✅" : "❌"}`);
  for (const path of ["/dashboard", "/leaves", "/requests", "/settings"]) {
    await m.goto("http://localhost:5173" + path, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1800);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    results.push(`mobile ${path}: overflow=${overflow}px ${overflow > 5 ? "⚠️ HORIZONTAL OVERFLOW" : "✅ fits"} | rendered=${(await m.evaluate(() => document.body.innerText.length)) > 100 ? "yes" : "NO"}`);
    await m.screenshot({ path: `./ui-shots/mobile${path.replace(/\//g, "-")}.png` });
  }
} catch (e) {
  results.push("❌ mobile failed: " + e.message);
} finally {
  await browser.close();
}
console.log(results.join("\n"));
fs.writeFileSync("./e2e-ui-mobile.txt", results.join("\n"));
