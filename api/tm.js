const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://15.235.182.3/konekta",
  username: "kami526",
  password: "kami526",
  userAgent:
    "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server", raw: text.substring(0, 300) };
  }
}

/* ================= REQUEST ================= */
function request(method, url, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;

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
    }

    console.log(`[REQ] ${method} ${url}`);

    const req = lib.request(url, { method, headers }, res => {
      console.log(`[RES] Status: ${res.statusCode} for ${url}`);

      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          cookies.push(c.split(";")[0]);
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
        console.log("[RES BODY PREVIEW]", body.substring(0, 600));
        resolve(body);
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ================= AUTO-CORRECT CAPTCHA + LOGIN ================= */
async function login() {
  cookies = [];
  isLoggedIn = false;

  const page = await request("GET", `${CONFIG.baseUrl}/sign-in`);

  // Multiple patterns for robust CAPTCHA detection
  const patterns = [
    /What is (\d+)\s*\+\s*(\d+)/i,
    /(\d+)\s*\+\s*(\d+)/i,
    /(\d+)\s*plus\s*(\d+)/i,
    /Captcha.*?(\d+)\s*\+\s*(\d+)/i,
    /(\d+)\s*[\+\-]\s*(\d+)/i
  ];

  let capt = 10;
  for (const regex of patterns) {
    const match = page.match(regex);
    if (match) {
      capt = Number(match[1]) + Number(match[2]);
      console.log("[CAPTCHA AUTO] Detected & solved:", capt);
      break;
    }
  }

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  await request(
    "POST",
    `${CONFIG.baseUrl}/signin`,
    form,
    { Referer: `${CONFIG.baseUrl}/sign-in` }
  );

  // Test session
  const test = await request("GET", `${CONFIG.baseUrl}/agent/`);
  if (test.includes("Please sign in") || test.includes("login") || test.includes("sign-in")) {
    throw new Error("Login failed - check credentials or CAPTCHA");
  }

  isLoggedIn = true;
  console.log("[LOGIN] Success");
}

/* ================= CHECK IF RESPONSE INDICATES EXPIRED SESSION ================= */
function isSessionExpired(body) {
  return (
    body.includes("Please sign in") ||
    body.includes("login") ||
    body.includes("sign-in") ||
    body.includes("session expired") ||
    body.includes("Direct Script Access") ||
    body.includes("Invalid") ||
    body.length < 200 // too short, likely error page
  );
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

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
  if (!data.aaData) return data;

  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "")
        .replace(/legendhacker/gi, "")
        .trim();

      if (!message) return null;

      return [
        row[0],
        row[1],
        row[2],
        row[3],
        message,
        "$",
        row[7] || 0
      ];
    })
    .filter(Boolean);

  return data;
}

/* ================= FETCH NUMBERS with AUTO RE-LOGIN ================= */
async function getNumbers() {
  if (!isLoggedIn) await login();

  const url =
    `${CONFIG.baseUrl}/agent/res/data_smsranges.php?` +
    `sEcho=2&iColumns=6&sColumns=%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=-1`;

  let data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSRanges`,
    "X-Requested-With": "XMLHttpRequest"
  });

  // Auto re-login if expired
  if (isSessionExpired(data)) {
    console.log("[RELOGIN TRIGGERED] for numbers");
    await login();
    data = await request("GET", url, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSRanges`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS with AUTO RE-LOGIN ================= */
async function getSMS() {
  if (!isLoggedIn) await login();

  // Wide range to include today's new OTPs
  const today = new Date();
  const d = `\( {today.getFullYear()}- \){String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const url =
    `${CONFIG.baseUrl}/agent/res/data_smscdr.php?` +
    `fdate1=\( {d}%2000:00:00&fdate2= \){d}%2023:59:59` +
    `&frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&fgnumber=&fgcli=&fg=0&iDisplayLength=5000`;

  let data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest"
  });

  // Auto re-login if expired
  if (isSessionExpired(data)) {
    console.log("[RELOGIN TRIGGERED] for SMS");
    await login();
    data = await request("GET", url, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  console.log("[SMS RAW PREVIEW]", data.substring(0, 600));

  return fixSMS(safeJSON(data));
}

/* ================= API ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers or ?type=sms" });
  }

  try {
    if (type === "numbers") return res.json(await getNumbers());
    if (type === "sms") return res.json(await getSMS());

    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.json({ error: err.message || "Request failed" });
  }
});

module.exports = router;
