const express = require("express");
const http = require("http");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://85.195.94.50",
  username: "junaidaliniz",
  password: "Junaid123",
  userAgent:
    "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36"
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

  const page = await request("GET", `${CONFIG.baseUrl}/sms/SignIn`);

  // Auto solve CAPTCHA (text-based math)
  const match = page.match(/(\d+)\s*\+\s*(\d+)\s*=\s*\?/i);
  const capt = match ? Number(match[1]) + Number(match[2]) : 10;

  console.log("[CAPTCHA AUTO]", capt);

  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt
  });

  await request(
    "POST",
    `${CONFIG.baseUrl}/sms/signmein`,
    form,
    { Referer: `${CONFIG.baseUrl}/sms/SignIn` }
  );

  // Test session
  const test = await request("GET", `${CONFIG.baseUrl}/sms/reseller/`);
  if (test.includes("SignIn") || test.includes("login")) {
    throw new Error("Login failed");
  }
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
    `${CONFIG.baseUrl}/sms/reseller/ajax/dt_numbers.php?` +
    `ftermination=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1`;

  const data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/sms/reseller/`,
    "X-Requested-With": "XMLHttpRequest"
  });

  return fixNumbers(safeJSON(data));
}

/* ================= FETCH SMS ================= */
async function getSMS() {
  await login();

  const today = new Date();

  const d = `\( {today.getFullYear()}- \){String(
    today.getMonth() + 1
  ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const url =
    `${CONFIG.baseUrl}/sms/reseller/ajax/dt_reports.php?` +
    `fdate1=\( {d}%2000:00:00&fdate2= \){d}%2023:59:59` +
    `&ftermination=&fclient=&fnum=&fcli=&fgdate=0&fgtermination=0&fgclient=0&fgnumber=0&fgcli=0&fg=0&` +
    `sEcho=2&iDisplayStart=0&iDisplayLength=5000`;

  const data = await request("GET", url, null, {
    Referer: `${CONFIG.baseUrl}/sms/reseller/SMSReports`,
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
    res.json({ error: err.message });
  }
});

module.exports = router;
