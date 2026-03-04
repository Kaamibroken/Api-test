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

/* SAFE JSON */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON", raw: text.slice(0, 200) };
  }
}

/* REQUEST */
function makeRequest(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;

    console.log(`[REQ] ${method} ${fullUrl}`);

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
        try {
          if (res.headers["content-encoding"] === "gzip") buffer = zlib.gunzipSync(buffer);
        } catch {}
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

  const page = await makeRequest("GET", "/login");

  const match = page.match(/What is (\d+)\s*\+\s*(\d+)\s*=?\s*\??/i);
  const capt = match ? Number(match[1]) + Number(match[2]) : 10;
  console.log(`[CAPTCHA] ${capt}`);

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
}

/* FIX SMS (same) */
function fixSMS(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      if (!message) return null;

      return [
        row[0] || "", // date
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

/* GET SMS - FINAL FIXED VERSION */
async function getSMS() {
  await login();  // Fresh login

  // Critical Step: Load the reports page first to satisfy server protection
  const reports = await makeRequest("GET", "/agent/SMSCDRReports", null, {
    Referer: `${CONFIG.baseUrl}/agent/`,
    "Upgrade-Insecure-Requests": "1",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  });

  console.log("[REPORTS LOADED]", reports.substring(0, 200)); // should have table or dashboard content

  // Date in PKT (Islamabad +5)
  const now = new Date();
  now.setHours(now.getHours() + 5); // rough PKT adjust
  const d = `\( {now.getFullYear()}- \){String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const params = querystring.stringify({
    fdate1: `${d} 00:00:00`,
    fdate2: `${d} 23:59:59`,
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
    sColumns: ",,,,,,,,",
    iDisplayStart: "0",
    iDisplayLength: "-1",
    mDataProp_0: "0",
    sSearch_0: "",
    bRegex_0: "false",
    bSearchable_0: "true",
    bSortable_0: "true",
    // ... (add more if needed, but most ignored)
    iSortCol_0: "0",
    sSortDir_0: "desc",
    iSortingCols: "1",
    _: Date.now().toString()
  });

  const smsRaw = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  console.log("[SMS RAW]", smsRaw.substring(0, 500)); // key debug: check if JSON or error

  if (smsRaw.includes("Direct Script Access") || smsRaw.includes("Please sign in")) {
    console.log("[BLOCKED] Retrying after reload...");
    await makeRequest("GET", "/agent/SMSCDRReports");
    // retry once
    const retryRaw = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest"
    });
    return fixSMS(safeJSON(retryRaw));
  }

  return fixSMS(safeJSON(smsRaw));
}

/* GET NUMBERS (unchanged) */
async function getNumbers() {
  await login();

  const params = querystring.stringify({
    frange: "",
    fclient: "",
    sEcho: "2",
    iDisplayStart: "0",
    iDisplayLength: "-1"
  });

  const data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data)); // assume fixNumbers same as original
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
    console.error(err.message);
    res.json({ error: err.message || "Failed" });
  }
});

module.exports = router;
