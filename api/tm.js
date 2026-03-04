const express = require("express");
const http = require("http");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://51.89.7.175/sms",
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
    return { error: "Invalid JSON", raw: text.substring(0, 300) };
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
      "Accept": "*/*",
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

/* LOGIN with AUTO CAPTCHA DETECT */
async function login() {
  cookies = [];
  isLoggedIn = false;

  const loginPage = await makeRequest("GET", "/SignIn");

  // Auto detect CAPTCHA (math question)
  const captMatch = loginPage.match(/What is (\d+)\s*[\+\-]\s*(\d+)/i) ||
                    loginPage.match(/(\d+)\s*[\+\-]\s*(\d+)/i);
  let capt = 10;
  if (captMatch) {
    const op = captMatch[0].includes('-') ? -1 : 1;
    capt = Number(captMatch[1]) + (op * Number(captMatch[2]));
  }

  console.log("[CAPTCHA AUTO] Detected:", capt);

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  const loginRes = await makeRequest("POST", "/signmein", form, {
    Referer: `${CONFIG.baseUrl}/SignIn`
  });

  if (loginRes.includes("Invalid") || loginRes.includes("captcha") || loginRes.includes("Please")) {
    throw new Error("Login failed - check credentials or CAPTCHA");
  }

  // Test protected page
  const test = await makeRequest("GET", "/client/");
  if (test.includes("SignIn") || test.includes("login")) {
    throw new Error("Login not successful");
  }

  isLoggedIn = true;
  console.log("[LOGIN] Success");
}

/* FIX SMS (same as before) */
function fixSMS(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      if (!message) return null;

      return [
        row[0] || "", // date/time
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

/* GET SMS - Wide range + your pattern */
async function getSMS() {
  await login();

  // Wide range: past to far future
  const startDate = "2026-02-26";
  const endDate = "2099-12-31";

  const params = [
    `fdate1=${encodeURIComponent(startDate + " 00:00:00")}`,
    `fdate2=${encodeURIComponent(endDate + " 23:59:59")}`,
    `ftermination=`,
    `fclient=`,
    `fnum=`,
    `fcli=`,
    `fgdate=0`,
    `fgtermination=0`,
    `fgclient=0`,
    `fgnumber=0`,
    `fgcli=0`,
    `fg=0`,
    `sEcho=1`,
    `iColumns=11`,
    `sColumns=%2C%2C%2C%2C%2C%2C%2C%2C%2C%2C`,
    `iDisplayStart=0`,
    `iDisplayLength=2000`,  // your value
    // Full DataTables params (from your log)
    `mDataProp_0=0`, `sSearch_0=`, `bRegex_0=false`, `bSearchable_0=true`, `bSortable_0=true`,
    `mDataProp_1=1`, `sSearch_1=`, `bRegex_1=false`, `bSearchable_1=true`, `bSortable_1=true`,
    `mDataProp_2=2`, `sSearch_2=`, `bRegex_2=false`, `bSearchable_2=true`, `bSortable_2=true`,
    `mDataProp_3=3`, `sSearch_3=`, `bRegex_3=false`, `bSearchable_3=true`, `bSortable_3=true`,
    `mDataProp_4=4`, `sSearch_4=`, `bRegex_4=false`, `bSearchable_4=true`, `bSortable_4=true`,
    `mDataProp_5=5`, `sSearch_5=`, `bRegex_5=false`, `bSearchable_5=true`, `bSortable_5=true`,
    `mDataProp_6=6`, `sSearch_6=`, `bRegex_6=false`, `bSearchable_6=true`, `bSortable_6=true`,
    `mDataProp_7=7`, `sSearch_7=`, `bRegex_7=false`, `bSearchable_7=true`, `bSortable_7=true`,
    `mDataProp_8=8`, `sSearch_8=`, `bRegex_8=false`, `bSearchable_8=true`, `bSortable_8=true`,
    `mDataProp_9=9`, `sSearch_9=`, `bRegex_9=false`, `bSearchable_9=true`, `bSortable_9=true`,
    `mDataProp_10=10`, `sSearch_10=`, `bRegex_10=false`, `bSearchable_10=true`, `bSortable_10=true`,
    `sSearch=`,
    `bRegex=false`,
    `iSortCol_0=0`,
    `sSortDir_0=desc`,
    `iSortingCols=1`,
    `_${Date.now()}`
  ].join('&');

  const urlPath = `/client/ajax/dt_reports.php?${params}`;

  // Load parent page
  try {
    await makeRequest("GET", "/client/", null, {
      Referer: `${CONFIG.baseUrl}/client/Numbers`
    });
  } catch {}

  let data = await makeRequest("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/client/Numbers`,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  console.log("[SMS RAW]", data.substring(0, 800));

  // Retry if needed
  if (data.includes("Direct Script Access") || data.includes("login")) {
    await login();
    data = await makeRequest("GET", urlPath, null, {
      Referer: `${CONFIG.baseUrl}/client/Numbers`,
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
