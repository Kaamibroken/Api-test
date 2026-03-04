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

/* FIX NUMBERS & SMS same as before */
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

/* GET NUMBERS (unchanged, working) */
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

/* GET SMS - FIXED VERSION */
async function getSMS() {
  await login();  // Fresh login har baar (important for this endpoint)

  // Load the parent stats page first - this sets session/context
  await makeRequest("GET", "/agent/SMSCDRStats", null, {
    Referer: `${CONFIG.baseUrl}/agent/`,
    "Upgrade-Insecure-Requests": "1"
  });

  // PKT timezone adjust
  const today = new Date();
  const pktOffset = 5 * 60; // +5 hours
  today.setMinutes(today.getMinutes() + today.getTimezoneOffset() + pktOffset);
  const d = `\( {today.getFullYear()}- \){String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  console.log("[SMS DATE USED]", d);

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
    iDisplayStart: "0",
    iDisplayLength: "5000",  // safer
    iSortCol_0: "0",
    sSortDir_0: "desc"
  });

  let data = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,  // exact match from your log
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  console.log("[SMS RESPONSE START]", data.substring(0, 500)); // debug

  if (data.includes("Direct Script Access") || data.includes("Please sign in")) {
    console.log("[RETRY]");
    await login();
    await makeRequest("GET", "/agent/SMSCDRStats");
    data = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,
      "X-Requested-With": "XMLHttpRequest"
    });
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
