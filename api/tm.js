const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://185.2.83.39/ints",
  username: "RAHMAN3333",
  password: "RAHMAN3333",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

let cookies = [];

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server" };
  }
}

/* ================= REQUEST ================= */
function request(method, url, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "X-Requested-With": "mark.via.gp",
      "Cookie": cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
    }

    const req = lib.request(url, { method, headers }, res => {
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
        resolve(buffer.toString());
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ================= LOGIN ================= */
async function login() {
  cookies = [];

  const page = await request("GET", `${CONFIG.baseUrl}/login`, null, {
    "X-Requested-With": "mark.via.gp"
  });

  const match = page.match(/What is (\d+) \+ (\d+)/i);
  const capt = match ? Number(match[1]) + Number(match[2]) : 6;

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  await request(
    "POST",
    `${CONFIG.baseUrl}/signin`,
    form,
    { 
      "Referer": `${CONFIG.baseUrl}/login`,
      "X-Requested-With": "mark.via.gp"
    }
  );

  // Go to agent area to set session
  await request("GET", `${CONFIG.baseUrl}/agent/`, null, {
    "Referer": `${CONFIG.baseUrl}/login`,
    "X-Requested-With": "mark.via.gp"
  });
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[0], // ID
    row[1], // Number
    row[2], // Client
    row[3], // Service
    (row[4] || "").replace(/<[^>]+>/g, "").trim(), // Expiry
    (row[5] || "").replace(/<[^>]+>/g, "").trim(), // Status
    (row[6] || "").replace(/<[^>]+>/g, "").trim(), // Notes
    (row[7] || "").replace(/<[^>]+>/g, "").trim()  // Actions
  ]);

  return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[0], // Date
    row[1], // Range
    row[2], // Number
    row[3], // Client
    row[4], // Source
    (row[5] || "").replace(/<[^>]+>/g, "").trim(), // Message
    row[6], // Type
    (row[7] || "").replace(/<[^>]+>/g, "").trim(), // Status
    (row[8] || "").replace(/<[^>]+>/g, "").trim()  // Actions
  ]);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  // Visit MySMSNumbers page first
  await request("GET", `${CONFIG.baseUrl}/agent/MySMSNumbers`, null, {
    "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
    "X-Requested-With": "mark.via.gp"
  });

  const timestamp = Date.now();
  const url =
    `${CONFIG.baseUrl}/agent/res/data_smsnumbers.php?` +
    `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${timestamp}`;

  const data = await request("GET", url, null, {
    "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS ================= */
async function getSMS() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const fdate1 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
  const fdate2 = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")} 23:59:59`;

  // Visit SMSCDRReports page first
  await request("GET", `${CONFIG.baseUrl}/agent/SMSCDRReports`, null, {
    "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
    "X-Requested-With": "mark.via.gp"
  });

  const timestamp = Date.now();
  const url =
    `${CONFIG.baseUrl}/agent/res/data_smscdr.php?` +
    `fdate1=${encodeURIComponent(fdate1)}&fdate2=${encodeURIComponent(fdate2)}` +
    `&frange=&fclient=&fnum=&fcli=&fg=0&iDisplayLength=5000&_=${timestamp}`;

  const data = await request("GET", url, null, {
    "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixSMS(safeJSON(data));
}

/* ================= API ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers or ?type=sms" });
  }

  try {
    await login();

    if (type === "numbers") {
      const result = await getNumbers();
      return res.json(result);
    }
    
    if (type === "sms") {
      const result = await getSMS();
      return res.json(result);
    }

    res.json({ error: "Invalid type" });
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
