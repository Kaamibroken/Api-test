const express = require("express");
const https = require("https");          // Changed to https
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "https://www.konektapremium.net",
  username: "kami526",
  password: "kami526",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;

/* SAFE JSON */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON", rawPreview: text.substring(0, 400) };
  }
}

/* REQUEST (now supports HTTPS) */
function makeRequest(method, path, postData = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;

    console.log(`[REQ] ${method} ${fullUrl}`);

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
      "Cookie": cookies.join("; "),
      "Connection": "keep-alive",
      ...extraHeaders
    };

    if (method === "POST" && postData) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(postData);
      headers["Origin"] = CONFIG.baseUrl;
      headers["Referer"] = `${CONFIG.baseUrl}/sign-in`;
    }

    const req = https.request(fullUrl, { method, headers }, (res) => {
      // Update cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const part = c.split(";")[0].trim();
          if (part && !cookies.includes(part)) cookies.push(part);
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));

      res.on("end", () => {
        let buffer = Buffer.concat(chunks);
        if (res.headers["content-encoding"] === "gzip" || res.headers["content-encoding"] === "br") {
          try {
            buffer = zlib.gunzipSync(buffer); // br ke liye bhi gunzip try (simple cases)
          } catch {}
        }
        resolve(buffer.toString("utf-8"));
      });
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/* LOGIN with math captcha */
async function login() {
  cookies = [];
  isLoggedIn = false;

  const loginPage = await makeRequest("GET", "/sign-in");

  // Find "What is X + Y = ?"
  const captMatch = loginPage.match(/What is\s*(\d+)\s*\+\s*(\d+)\s*=?\s*\??/i);
  const capt = captMatch ? Number(captMatch[1]) + Number(captMatch[2]) : 10;

  console.log(`[CAPTCHA] Detected: ${capt}`);

  const formData = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt: capt.toString()
  });

  await makeRequest("POST", "/signin", formData, {
    "Referer": `${CONFIG.baseUrl}/sign-in`,
    "X-Requested-With": "mark.via.gp"  // tumhara original header
  });

  // Verify
  const dashboard = await makeRequest("GET", "/agent/");
  if (dashboard.includes("Please sign in") || dashboard.includes("sign-in")) {
    throw new Error("Login failed - still on login page");
  }

  isLoggedIn = true;
  console.log("[LOGIN] Success");
}

/* FIX SMS (rearrange to message @5, client @6) */
function fixSMS(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData.map(row => {
    // Original likely: [time?, number, source?, ?, message/fallback, client?, cost?, status?]
    let message = (row[4] || row[5] || "").trim();
    let client  = row[5] || row[6] || "";

    if (!message) return null;

    return [
      row[0] || "",   // 0
      row[1] || "",   // 1 time/date
      row[2] || "",   // 2 number
      row[3] || "",   // 3 source
      "",             // 4 empty (legacy fallback)
      message,        // 5 MESSAGE
      client,         // 6 CLIENT
      row[7] || "0",  // 7 cost
      row[8] || ""    // 8 status
    ];
  }).filter(Boolean);

  return data;
}

/* GET SMS (SMSCDR) */
async function getSMS() {
  if (!isLoggedIn) await login();

  const start = "2026-03-01 00:00:00";
  const end   = "2026-12-31 23:59:59";  // Adjust wider if needed

  const params = querystring.stringify({
    fdate1: start,
    fdate2: end,
    frange: "",
    fclient: "",
    fnum: "",
    fcli: "",
    fgdate: "",
    fgmonth: "",
    fgrange: "",
    fgclient: "",
    fgnumber: "",
    fgcli: "",
    fg: "0",
    sEcho: "2",
    iColumns: "9",
    iDisplayStart: "0",
    iDisplayLength: "-1",   // All records
    _: Date.now()
  });

  const apiUrl = `/agent/res/data_smscdr.php?${params}`;

  // Pre-load page (some sites need it)
  await makeRequest("GET", "/agent/SMSCDRReports").catch(() => {});

  let raw = await makeRequest("GET", apiUrl, null, {
    "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest"
  });

  if (raw.includes("Direct Script Access") || raw.includes("sign-in")) {
    console.log("[RETRY] Relogging...");
    await login();
    await makeRequest("GET", "/agent/SMSCDRReports");
    raw = await makeRequest("GET", apiUrl, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  const json = safeJSON(raw);
  return fixSMS(json);
}

/* ROUTE */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) return res.json({ error: "Use ?type=sms" });

  try {
    if (type === "sms") {
      const result = await getSMS();
      return res.json(result);
    }
    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message || "Failed" });
  }
});

module.exports = router;
