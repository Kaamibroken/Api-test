const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://www.timesms.net",
  username: "Kami526",
  password: "Kami526",
  userAgent:
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false; // track session state roughly

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server", raw: text.substring(0, 200) };
  }
}

/* ================= REQUEST ================= */
function request(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = `\( {CONFIG.baseUrl} \){path.startsWith('/') ? path : '/' + path}`;
    const lib = fullUrl.startsWith("https") ? https : http;

    const headers = {
      "User-Agent": CONFIG.userAgent,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate",
      Cookie: cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers.Origin = CONFIG.baseUrl;
    }

    console.log(`[REQ] ${method} ${fullUrl}`); // debug - remove later

    const req = lib.request(fullUrl, { method, headers }, res => {
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const part = c.split(";")[0];
          if (!cookies.includes(part)) cookies.push(part);
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));

      res.on("end", () => {
        let buffer = Buffer.concat(chunks);
        try {
          if (res.headers["content-encoding"] === "gzip") {
            buffer = zlib.gunzipSync(buffer);
          }
        } catch {}
        const body = buffer.toString();
        resolve(body);
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ================= SMART LOGIN / RE-LOGIN ================= */
async function ensureLoggedIn(maxRetries = 1) {
  if (isLoggedIn) return true;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      cookies = []; // fresh start per login attempt
      const page = await request("GET", "/login");

      // Multiple patterns for robustness
      let capt = 0;
      const patterns = [
        /What is (\d+)\s*[\+\-]\s*(\d+)\s*=?\s*\??/i,
        /(\d+)\s*[\+\-]\s*(\d+)/i,
        /Captcha.*?(\d+)\s*[\+\-]\s*(\d+)/i
      ];

      for (const regex of patterns) {
        const match = page.match(regex);
        if (match) {
          capt = Number(match[1]) + Number(match[2]); // assuming + (change if - appears)
          break;
        }
      }

      if (capt === 0) {
        console.warn("[CAPTCHA] No math expression found, using fallback 10");
        capt = 10;
      }

      const form = querystring.stringify({
        username: CONFIG.username,
        password: CONFIG.password,
        capt: capt
      });

      const loginBody = await request(
        "POST",
        "/signin",
        form,
        { Referer: `${CONFIG.baseUrl}/login` }
      );

      // Check success signals
      if (
        loginBody.includes("Please sign in") ||
        loginBody.includes("Invalid") ||
        loginBody.includes("captcha") ||
        loginBody.length < 200 // too short → probably error page
      ) {
        throw new Error(`Login attempt ${attempt} failed - bad response`);
      }

      // Quick check: try to access a protected page
      const test = await request("GET", "/agent/");
      if (test.includes("Please sign in") || test.includes("login")) {
        throw new Error("Session not active after login");
      }

      isLoggedIn = true;
      console.log("[LOGIN] Success");
      return true;

    } catch (e) {
      console.error(`[LOGIN] Attempt ${attempt} failed: ${e.message}`);
      if (attempt === maxRetries + 1) throw e;
      await new Promise(r => setTimeout(r, 1500)); // small delay before retry
    }
  }
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data?.aaData) return data;
  data.aaData = data.aaData.map(row => [
    row[1] || "",
    "",
    row[3] || "",
    "Weekly",
    (row[4] || "").replace(/<[^>]+>/g, "").trim(),
    (row[7] || "").replace(/<[^>]+>/g, "").trim()
  ]);
  return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData
    .map(row => {
      let msg = (row[5] || "").replace(/legendhacker/gi, "").trim();
      if (!msg) return null;

      return [
        row[0] || "",
        row[1] || "",
        row[2] || "",
        row[3] || "",
        msg,
        "$",
        row[7] || 0
      ];
    })
    .filter(Boolean);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  await ensureLoggedIn();

  const params = new URLSearchParams({
    frange: "",
    fclient: "",
    sEcho: "2",
    iDisplayStart: "0",
    iDisplayLength: "-1"
  }).toString();

  const body = await request("GET", `/agent/res/data_smsnumbers.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  const json = safeJSON(body);

  // Auto re-login trigger if looks like logged out
  if (
    !json.aaData ||
    body.includes("Please sign in") ||
    body.includes("Direct Script Access") ||
    body.includes("login") ||
    (Array.isArray(json.aaData) && json.aaData.length === 0 && body.length < 500)
  ) {
    isLoggedIn = false;
    await ensureLoggedIn();
    return getNumbers(); // retry once
  }

  return fixNumbers(json);
}

/* ================= FETCH SMS ================= */
async function getSMS() {
  await ensureLoggedIn();

  const today = new Date();
  const d = `\( {today.getFullYear()}- \){String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    fdate1: `${d} 00:00:00`,
    fdate2: `${d} 23:59:59`,
    frange: "",
    fclient: "",
    fnum: "",
    fcli: "",
    fg: "0",
    iDisplayLength: "5000"
  }).toString();

  const body = await request("GET", `/agent/res/data_smscdr.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`, // or /SMSCDRReports — test both
    "X-Requested-With": "XMLHttpRequest"
  });

  const json = safeJSON(body);

  // Same auto-relogin check
  if (
    !json.aaData ||
    body.includes("Please sign in") ||
    body.includes("Direct Script Access") ||
    body.includes("login") ||
    (Array.isArray(json.aaData) && json.aaData.length === 0 && body.length < 500)
  ) {
    isLoggedIn = false;
    await ensureLoggedIn();
    return getSMS(); // retry once
  }

  return fixSMS(json);
}

/* ================= API ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers or ?type=sms" });
  }

  try {
    if (type === "numbers") {
      return res.json(await getNumbers());
    }
    if (type === "sms") {
      return res.json(await getSMS());
    }
    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error("[API ERROR]", err);
    isLoggedIn = false; // force relogin next time
    res.status(500).json({ error: err.message || "Server error" });
  }
});

module.exports = router;
