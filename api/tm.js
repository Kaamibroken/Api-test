const express = require("express");
const http = require("http");
const https = require("https"); // kept but not needed here
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

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server", raw: text.substring(0, 300) };
  }
}

/* ================= REQUEST ================= */
function request(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = `\( {CONFIG.baseUrl} \){path}`;
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
      headers.Origin = CONFIG.baseUrl;
    }

    const req = lib.request(url, { method, headers }, res => {
      // Capture new cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const cookiePart = c.split(";")[0];
          if (!cookies.includes(cookiePart)) cookies.push(cookiePart);
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
        } catch (e) {}
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
  cookies = []; // reset cookies each time (or keep if you want persistent session)

  // Get login page to extract CAPTCHA
  const page = await request("GET", "/login");

  // Extract math captcha (What is X + Y)
  const match = page.match(/What is (\d+) \+ (\d+)/i) || page.match(/(\d+)\s*\+\s*(\d+)/i);
  let capt = 10; // fallback
  if (match) {
    capt = Number(match[1]) + Number(match[2]);
  }

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt: capt
  });

  const loginRes = await request(
    "POST",
    "/signin",
    form,
    { Referer: `${CONFIG.baseUrl}/login` }
  );

  // Optional: check if login succeeded (look for redirect or dashboard text)
  if (loginRes.includes("Please sign in") || loginRes.includes("Invalid")) {
    throw new Error("Login failed - check credentials or CAPTCHA parsing");
  }
}

/* ================= FIX NUMBERS (adjust columns if needed after testing) ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[1] || "",           // number / range
    "",                     // empty as in original
    row[3] || "",           // status / type?
    "Weekly",               // hardcoded as in original
    (row[4] || "").replace(/<[^>]+>/g, "").trim(), // clean html
    (row[7] || "").replace(/<[^>]+>/g, "").trim()  // another field
  ]);

  return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "")
        .replace(/legendhacker/gi, "") // from original — keep or remove if not needed
        .trim();

      if (!message) return null;

      return [
        row[0] || "", // date/time
        row[1] || "", // range?
        row[2] || "", // from number
        row[3] || "", // service/provider
        message,      // OTP / message
        "$",          // placeholder as in original
        row[7] || 0   // status / price?
      ];
    })
    .filter(Boolean);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  const params = new URLSearchParams({
    frange: "",
    fclient: "",
    sEcho: "2",
    iDisplayStart: "0",
    iDisplayLength: "-1"
    // add more params if server requires them strictly
  }).toString();

  const urlPath = `/agent/res/data_smsnumbers.php?${params}`;

  const data = await request("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS (today's) ================= */
async function getSMS() {
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
    iDisplayLength: "5000" // or -1 if server allows
    // fgdate, fgmonth etc. left empty as in your log
  }).toString();

  const urlPath = `/agent/res/data_smscdr.php?${params}`;

  const data = await request("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`, // or /SMSCDRStats if better
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

    if (type === "numbers") return res.json(await getNumbers());
    if (type === "sms") return res.json(await getSMS());

    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message || "Request failed" });
  }
});

module.exports = router;
