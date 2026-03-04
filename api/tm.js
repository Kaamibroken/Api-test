const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://167.114.117.67/ints",
  username: "ZONEY11",
  password: "@zoney123",
  userAgent:
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/144 Mobile"
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
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate",
      Cookie: cookies.join("; "),
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

  const page = await request("GET", `${CONFIG.baseUrl}/login`);

  const match = page.match(/What is (\d+) \+ (\d+)/i);
  const capt = match ? Number(match[1]) + Number(match[2]) : 10;

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  await request(
    "POST",
    `${CONFIG.baseUrl}/signin`,
    form,
    { Referer: `${CONFIG.baseUrl}/login` }
  );
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
        row[0], // date
        row[1], // range
        row[2], // number
        row[3], // service
        message, // OTP MESSAGE
        "$",
        row[7] || 0
      ];
    })
    .filter(Boolean);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  const url =
    `${CONFIG.baseUrl}/agent/res/data_smsnumbers.php?` +
    `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1`;

  const data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS ================= */
async function getSMS() {
  await login();

  // Wide range taake aaj ke naye SMS bhi aa jaye (tumhare last message se inspired)
  const startDate = "2026-02-21";
  const endDate = "2099-12-31";

  const url =
    `${CONFIG.baseUrl}/agent/res/data_smscdr.php?` +
    `fdate1=${encodeURIComponent(startDate + " 00:00:00")}&` +
    `fdate2=${encodeURIComponent(endDate + " 23:59:59")}&` +
    `frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&fgnumber=&fgcli=&fg=0&` +
    `sEcho=1&iColumns=9&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000`;

  const data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "XMLHttpRequest"
  });

  console.log("[SMS RAW PREVIEW]", data.substring(0, 600)); // debug

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
    console.error("[ERROR]", err.message);
    res.json({ error: err.message || "Request failed" });
  }
});

module.exports = router;
