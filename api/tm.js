const express = require("express");
const https   = require("https");
const zlib    = require("zlib");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL       = "https://www.ivasms.com";
const EMAIL          = "shahzebjansolangi@gmail.com";
const PASSWORD       = "Kamran5.";
const TERMINATION_ID = "1029603";

const USER_AGENT = "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.159 Mobile Safari/537.36";

/* ================= STATE ================= */
let STATE = {
  cookies:      {},
  token:        null,
  loginPromise: null,
  lastLogin:    null
};

/* ================= HELPERS ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function cookieString() {
  return Object.entries(STATE.cookies).map(([k,v]) => `${k}=${v}`).join("; ");
}

function getXsrf() {
  try { return decodeURIComponent(STATE.cookies["XSRF-TOKEN"] || ""); }
  catch { return STATE.cookies["XSRF-TOKEN"] || ""; }
}

function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

/* ================= PUPPETEER LOGIN ================= */
async function puppeteerLogin() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    throw new Error("puppeteer not installed. Run: npm install puppeteer");
  }

  console.log("🌐 [IVAS] Launching browser...");

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 390, height: 844, isMobile: true });

    console.log("📄 [IVAS] Opening login page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for Cloudflare Turnstile to auto-solve
    console.log("⏳ [IVAS] Waiting for Turnstile...");
    await page.waitForFunction(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      return el && el.value && el.value.length > 10;
    }, { timeout: 20000 }).catch(() => {
      console.warn("⚠️ [IVAS] Turnstile timeout — proceeding anyway");
    });

    console.log("✏️ [IVAS] Filling form...");
    await page.evaluate((email, pass) => {
      document.querySelector('input[name="email"]').value    = email;
      document.querySelector('input[name="password"]').value = pass;
      const rem = document.querySelector('input[name="remember"]');
      if (rem) rem.checked = true;
    }, EMAIL, PASSWORD);

    console.log("🚀 [IVAS] Submitting...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('button[type="submit"]')
    ]);

    const currentUrl = page.url();
    console.log("📍 [IVAS] Landed:", currentUrl);

    if (currentUrl.includes("/login")) {
      throw new Error("Login failed — wrong credentials or Turnstile blocked");
    }

    const pageCookies = await page.cookies();
    STATE.cookies = {};
    pageCookies.forEach(c => { STATE.cookies[c.name] = c.value; });
    console.log("🍪 [IVAS] Cookies:", Object.keys(STATE.cookies).join(", "));

    await page.goto(`${BASE_URL}/portal`, { waitUntil: "networkidle2", timeout: 20000 });
    const html  = await page.content();
    const match = html.match(/name="_token"\s+value="([^"]+)"/) ||
                  html.match(/content="([^"]+)"\s+name="csrf-token"/);
    STATE.token     = match ? match[1] : null;
    STATE.lastLogin = Date.now();

    console.log(`✅ [IVAS] Login OK! Token: ${STATE.token ? STATE.token.substring(0,15)+"..." : "NOT FOUND"}`);

  } finally {
    await browser.close();
  }
}

/* ================= LOGIN MANAGER ================= */
function performLogin() {
  if (STATE.loginPromise) return STATE.loginPromise;
  STATE.loginPromise = puppeteerLogin().finally(() => { STATE.loginPromise = null; });
  return STATE.loginPromise;
}

function isSessionValid() {
  if (!STATE.token || !STATE.cookies["ivas_sms_session"]) return false;
  if (!STATE.lastLogin) return false;
  return (Date.now() - STATE.lastLogin) < 90 * 60 * 1000;
}

/* ================= HTTP REQUEST ================= */
function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent":       USER_AGENT,
      "Accept":           "*/*",
      "Accept-Encoding":  "gzip, deflate, br",
      "Accept-Language":  "en-PK,en;q=0.9",
      "Cookie":           cookieString(),
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN":     getXsrf(),
      "Origin":           BASE_URL,
      "Referer":          `${BASE_URL}/portal`,
      ...extraHeaders
    };

    if (method === "POST" && body) {
      headers["Content-Type"]   = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = https.request(BASE_URL + path, { method, headers }, res => {
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const sc = c.split(";")[0];
          const ki = sc.indexOf("=");
          if (ki > -1) {
            const k = sc.substring(0, ki).trim();
            const v = sc.substring(ki + 1).trim();
            if (k) STATE.cookies[k] = v;
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch {}

        const text = buf.toString("utf-8");
        if (res.statusCode === 401 || res.statusCode === 419 ||
            text.includes('"message":"Unauthenticated"')) {
          return reject(new Error("SESSION_EXPIRED"));
        }
        resolve({ status: res.statusCode, body: text });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= GET NUMBERS ================= */
async function getNumbers() {
  const body = `termination_id=${TERMINATION_ID}&_token=${STATE.token}`;
  const resp = await makeRequest(
    "POST", "/portal/live/getNumbers", body,
    "application/x-www-form-urlencoded; charset=UTF-8",
    { "Referer": `${BASE_URL}/portal/live/my_sms` }
  );
  return safeJSON(resp.body);
}

/* ================= GET SMS ================= */
async function getSMS() {
  const today    = getToday();
  const boundary = "----WebKitFormBoundary" + Date.now().toString(16).toUpperCase();

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${STATE.token}`,
    `--${boundary}--`
  ].join("\r\n");

  const resp = await makeRequest(
    "POST", "/portal/sms/received/getsms", parts,
    `multipart/form-data; boundary=${boundary}`,
    {
      "Referer":    `${BASE_URL}/portal/sms/received`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "text/html, */*; q=0.01"
    }
  );
  return safeJSON(resp.body);
}

/* ================= AUTO REFRESH every 85 min ================= */
setInterval(() => {
  console.log("🔄 [IVAS] Auto-refreshing...");
  performLogin().catch(e => console.error("[IVAS] Refresh failed:", e.message));
}, 85 * 60 * 1000);

/* ================= ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;
  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    if (!isSessionValid()) {
      console.log("🔄 [IVAS] Re-logging in...");
      await performLogin();
    }

    if (!STATE.token) {
      return res.status(401).json({ error: "Login failed — token not found" });
    }

    if (type === "numbers") return res.json(await getNumbers());
    if (type === "sms")     return res.json(await getSMS());

    res.json({ error: "Invalid type. Use numbers or sms" });

  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      STATE.token = null; STATE.cookies = {}; STATE.lastLogin = null;
      performLogin().catch(() => {});
      return res.status(503).json({ error: "Session expired — re-logging in, retry in 30s" });
    }
    res.status(500).json({ error: err.message });
  }
});

/* ================= INITIAL LOGIN ================= */
performLogin().catch(e => console.error("[IVAS] Initial login:", e.message));

module.exports = router;
