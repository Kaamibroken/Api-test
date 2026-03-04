const express = require("express");
const http = require("http");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://www.timesms.net",  // NO trailing slash!
  username: "Kami526",
  password: "Kami526",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server" };
  }
}

/* ================= REQUEST ================= */
function makeRequest(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    // Normalize path: always start with /
    let cleanPath = path.trim();
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

    const fullUrl = CONFIG.baseUrl + cleanPath;

    // Guard against common mistakes (double domain, invalid chars)
    if (fullUrl.includes('http:') && fullUrl.indexOf('http:') !== fullUrl.lastIndexOf('http:')) {
      console.error("[URL ERROR] Double protocol/domain detected:", fullUrl);
      return reject(new Error("Invalid URL - double domain"));
    }
    if (!fullUrl.startsWith('http://www.timesms.net')) {
      console.error("[URL ERROR] Bad base:", fullUrl);
      return reject(new Error("Invalid URL - wrong base"));
    }

    console.log(`[DEBUG REQUEST] ${method} ${fullUrl}`);  // <--- This shows exactly what is sent

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Cookie": cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
      headers["Referer"] = `${CONFIG.baseUrl}/login`;
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
          if (res.headers["content-encoding"] === "gzip") {
            buffer = zlib.gunzipSync(buffer);
          }
        } catch {}
        resolve(buffer.toString());
      });
    });

    req.on("error", err => {
      console.error("[REQUEST FAIL]", err.message, fullUrl);
      reject(err);
    });

    if (data) req.write(data);
    req.end();
  });
}

/* ================= LOGIN ================= */
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

  await makeRequest("POST", "/signin", form);

  // Quick check
  const test = await makeRequest("GET", "/agent/");
  if (test.includes("Please sign in") || test.includes("login")) {
    throw new Error("Login failed");
  }

  isLoggedIn = true;
}

/* ================= ENSURE LOGIN + AUTO RELOGIN ================= */
async function ensureLogin() {
  if (isLoggedIn) return;

  try {
    await login();
  } catch (e) {
    console.error("[LOGIN ERROR]", e.message);
    throw e;
  }
}

function isLoggedOutResponse(body) {
  return body.includes("Please sign in") ||
         body.includes("login") ||
         body.includes("Direct Script Access") ||
         body.includes("Invalid");
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[1],
    "",
    row[3],
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

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  await ensureLogin();

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

  if (isLoggedOutResponse(data)) {
    isLoggedIn = false;
    await ensureLogin();
    data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${params}`, null, {
      Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS ================= */
async function getSMS() {
  await ensureLogin();

  const today = new Date();
  const d = `\( {today.getFullYear()}- \){String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const params = querystring.stringify({
    fdate1: `${d} 00:00:00`,
    fdate2: `${d} 23:59:59`,
    frange: "",
    fclient: "",
    fnum: "",
    fcli: "",
    fg: "0",
    iDisplayLength: "-1"
  });

  let data = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,
    "X-Requested-With": "XMLHttpRequest"
  });

  if (isLoggedOutResponse(data)) {
    isLoggedIn = false;
    await ensureLogin();
    data = await makeRequest("GET", `/agent/res/data_smscdr.php?${params}`, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,
      "X-Requested-With": "XMLHttpRequest"
    });
  }

  return fixSMS(safeJSON(data));
}

/* ================= ROUTE ================= */
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
    isLoggedIn = false;
    res.json({ error: err.message || "Request failed" });
  }
});

module.exports = router;
