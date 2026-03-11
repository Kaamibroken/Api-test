const express = require("express");
const https = require("https");
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

/* REQUEST */
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
            buffer = zlib.gunzipSync(buffer);
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
    "X-Requested-With": "mark.via.gp"
  });

  const dashboard = await makeRequest("GET", "/agent/");
  if (dashboard.includes("Please sign in") || dashboard.includes("sign-in")) {
    throw new Error("Login failed - still on login page");
  }

  isLoggedIn = true;
  console.log("[LOGIN] Success");
}

/* FIX SMS */
function fixSMS(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData.map(row => {
    let message = (row[4] || row[5] || "").trim();
    let client  = row[5] || row[6] || "";

    if (!message) return null;

    return [
      row[0] || "",
      row[1] || "",
      row[2] || "",
      row[3] || "",
      "",
      message,
      client,
      row[7] || "0",
      row[8] || ""
    ];
  }).filter(Boolean);

  return data;
}

/* GET SMS */
async function getSMS() {
  if (!isLoggedIn) await login();

  const start = "2026-03-01 00:00:00";
  const end   = "2026-12-31 23:59:59";

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
    iDisplayLength: "-1",
    _: Date.now()
  });

  const apiUrl = `/agent/res/data_smscdr.php?${params}`;

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

/* FIX NUMBERS */
function fixNumbers(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData.map(row => {
    return [
      row[1] || "",
      "Active",
      row[3] || "",
      "Weekly",
      (row[4] || "").replace(/<[^>]+>/g, "").trim(),
      (row[6] || "0.00").toString()
    ];
  });

  console.log(`[Numbers] Fixed ${data.aaData.length} entries`);
  return data;
}

/* GET NUMBERS */
async function getNumbers() {
  if (!isLoggedIn) await login();

  const params = querystring.stringify({
    frange: "",
    fclient: "",
    fnumber: "",
    sEcho: "2",
    iColumns: "8",
    iDisplayStart: "0",
    iDisplayLength: "-1",
    mDataProp_0: "0",
    bSortable_0: "false",
    iSortCol_0: "0",
    sSortDir_0: "asc",
    _: Date.now().toString()
  });

  const apiUrl = `/agent/res/data_smsnumbers.php?${params}`;

  await makeRequest("GET", "/agent/MySMSNumbers").catch(() => {
    console.warn("[PRELOAD] MySMSNumbers page failed");
  });

  let raw = await makeRequest("GET", apiUrl, null, {
    "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  if (raw.includes("Direct Script Access") || raw.includes("sign-in") || raw.includes("Please sign in")) {
    console.log("[RETRY Numbers] Relogging...");
    await login();
    await makeRequest("GET", "/agent/MySMSNumbers");
    raw = await makeRequest("GET", apiUrl, null, {
      "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  const json = safeJSON(raw);
  return fixNumbers(json);
}

/* MAIN ROUTE */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers or ?type=sms" });
  }

  try {
    if (type === "sms") {
      const result = await getSMS();
      return res.json(result);
    }
    if (type === "numbers") {
      const result = await getNumbers();
      return res.json(result);
    }
    return res.json({ error: "Invalid type. Use numbers or sms" });
  } catch (err) {
    console.error("[API ERROR]", err.message || err);
    res.status(500).json({ error: err.message || "Operation failed" });
  }
});

module.exports = router;
