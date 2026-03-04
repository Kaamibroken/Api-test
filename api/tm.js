const express = require("express");
const http = require("http");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://www.timesms.net",
  username: "Kami526",
  password: "Kami526",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;

/* SAFE JSON */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server" };
  }
}

/* REQUEST */
function makeRequest(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;

    if (fullUrl.includes('http:') && fullUrl.indexOf('http:') !== fullUrl.lastIndexOf('http:')) {
      return reject(new Error("Invalid URL - double domain"));
    }

    console.log(`[DEBUG] ${method} ${fullUrl}`);

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-PK,en;q=0.9",
      "Cookie": cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
    }

    const req = http.request(fullUrl, { method, headers }, res => {
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
        if (res.headers["content-encoding"] === "gzip") {
          try { buffer = zlib.gunzipSync(buffer); } catch {}
        }
        resolve(buffer.toString());
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* LOGIN */
async function login() {
  cookies = [];
  isLoggedIn = false;

  const page = await makeRequest("GET", "/login");

  const match = page.match(/What is (\d+)\s*\+\s*(\d+)\s*=?\s*\??/i);
  const capt = match ? Number(match[1]) + Number(match[2]) : 10;

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  await makeRequest("POST", "/signin", form, {
    Referer: `${CONFIG.baseUrl}/login`
  });

  const test = await makeRequest("GET", "/agent/");
  if (test.includes("Please sign in") || test.includes("login")) {
    throw new Error("Login failed");
  }

  isLoggedIn = true;
}

/* FIX NUMBERS & SMS */
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

function fixSMS(data) {
  if (!data.aaData) return data;
  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      if (!message) return null;
      return [
        row[0] || "",
        row[1] || "",
        row[2] || "",
        row[3] || "",
        message,
        "$",
        row[7] || 0
      ];
    })
    .filter(Boolean);
  return data;
}

/* GET NUMBERS */
async function getNumbers() {
  if (!isLoggedIn) await login();

  const params = querystring.stringify({
    frange: "",
    fclient: "",
    sEcho: "2",
    iDisplayStart: "0",
    iDisplayLength: "-1"
  });

  let data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data));
}

/* GET SMS - USING YOUR EXACT LONG URL PATTERN */
async function getSMS() {
  await login();  // Fresh login

  // PKT date (UTC+5)
  const now = new Date();
  const pktTime = new Date(now.getTime() + (5 * 60 * 60 * 1000));
  const d = `\( {pktTime.getFullYear()}- \){String(pktTime.getMonth() + 1).padStart(2, "0")}-${String(pktTime.getDate()).padStart(2, "0")}`;

  console.log("[SMS] Using date:", d);

  // Your exact long parameter string (fixed & encoded properly)
  const params = [
    `fdate1=${encodeURIComponent(d + " 00:00:00")}`,
    `fdate2=${encodeURIComponent(d + " 23:59:59")}`,
    `frange=`,
    `fclient=`,
    `fnum=`,
    `fcli=`,
    `fgdate=`,
    `fgmonth=`,
    `fgrange=`,
    `fgclient=`,
    `fgnumber=`,
    `fgcli=`,
    `fg=0`,
    `sEcho=2`,
    `iColumns=9`,
    `sColumns=%2C%2C%2C%2C%2C%2C%2C%2C`,
    `iDisplayStart=0`,
    `iDisplayLength=-1`,
    `mDataProp_0=0`, `sSearch_0=`, `bRegex_0=false`, `bSearchable_0=true`, `bSortable_0=true`,
    `mDataProp_1=1`, `sSearch_1=`, `bRegex_1=false`, `bSearchable_1=true`, `bSortable_1=true`,
    `mDataProp_2=2`, `sSearch_2=`, `bRegex_2=false`, `bSearchable_2=true`, `bSortable_2=true`,
    `mDataProp_3=3`, `sSearch_3=`, `bRegex_3=false`, `bSearchable_3=true`, `bSortable_3=true`,
    `mDataProp_4=4`, `sSearch_4=`, `bRegex_4=false`, `bSearchable_4=true`, `bSortable_4=true`,
    `mDataProp_5=5`, `sSearch_5=`, `bRegex_5=false`, `bSearchable_5=true`, `bSortable_5=true`,
    `mDataProp_6=6`, `sSearch_6=`, `bRegex_6=false`, `bSearchable_6=true`, `bSortable_6=true`,
    `mDataProp_7=7`, `sSearch_7=`, `bRegex_7=false`, `bSearchable_7=true`, `bSortable_7=true`,
    `mDataProp_8=8`, `sSearch_8=`, `bRegex_8=false`, `bSearchable_8=true`, `bSortable_8=false`,
    `sSearch=`,
    `bRegex=false`,
    `iSortCol_0=0`,
    `sSortDir_0=desc`,
    `iSortingCols=1`,
    `_${Date.now()}`
  ].join('&');

  const urlPath = `/agent/res/data_smscdr.php?${params}`;

  console.log("[SMS] Full URL:", CONFIG.baseUrl + urlPath);

  // Load parent page first
  try {
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      Referer: `${CONFIG.baseUrl}/agent/`,
      "Upgrade-Insecure-Requests": "1"
    });
    console.log("[SMS] Loaded SMSCDRReports");
  } catch (err) {
    console.warn("[SMS] SMSCDRReports load failed:", err.message);
  }

  let data = await makeRequest("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  console.log("[SMS RESPONSE PREVIEW]", data.substring(0, 600));

  // Retry if blocked
  if (data.includes("Direct Script Access") || data.includes("Please sign in")) {
    console.log("[SMS] Blocked - retrying...");
    await login();
    await makeRequest("GET", "/agent/SMSCDRReports");
    data = await makeRequest("GET", urlPath, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest"
    });
    console.log("[SMS RETRY PREVIEW]", data.substring(0, 600));
  }

  const json = safeJSON(data);
  return fixSMS(json);
}

/* ROUTE */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    if (type === "numbers") return res.json(await getNumbers());
    if (type === "sms") return res.json(await getSMS());
    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message || "Failed" });
  }
});

module.exports = router;
