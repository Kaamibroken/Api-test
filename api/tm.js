const express = require("express");
const http = require("http");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://www.timesms.net",
  username: "Kami526",
  password: "Kami526",
  userAgent:
    "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: "Invalid JSON", raw: text.slice(0, 150) };
  }
}

/* ================= REQUEST HELPER ================= */
function makeRequest(method, path, postData = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = `\( {CONFIG.baseUrl} \){path.startsWith('/') ? '' : '/'}${path}`;
    const lib = http; // site is http only

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Cookie": cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && postData) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(postData);
      headers["Origin"] = CONFIG.baseUrl;
    }

    console.log(`[REQ] ${method} ${fullUrl}`); // debug

    const req = lib.request(fullUrl, { method, headers }, (res) => {
      // Update cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach((c) => {
          const part = c.split(";")[0];
          if (!cookies.includes(part)) cookies.push(part);
        });
      }

      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        if (res.headers["content-encoding"] === "gzip") {
          try {
            body = zlib.gunzipSync(body);
          } catch {}
        }
        resolve(body.toString("utf-8"));
      });
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/* ================= LOGIN / RE-LOGIN ================= */
async function login() {
  cookies = []; // fresh session
  isLoggedIn = false;

  const loginPage = await makeRequest("GET", "/login");

  // Improved regex - matches real pattern "What is 4 + 7 = ?"
  const captchaRegex = /What is (\d+)\s*\+\s*(\d+)\s*=?\s*\??/i;
  const match = loginPage.match(captchaRegex);

  let capt = 10; // fallback
  if (match && match[1] && match[2]) {
    capt = Number(match[1]) + Number(match[2]);
    console.log(`[CAPTCHA] Detected: ${match[1]} + ${match[2]} = ${capt}`);
  } else {
    console.log("[CAPTCHA] Not found - using fallback");
  }

  const formData = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt: capt
  });

  const loginResponse = await makeRequest(
    "POST",
    "/signin",
    formData,
    { Referer: `${CONFIG.baseUrl}/login` }
  );

  if (
    loginResponse.includes("Please sign in") ||
    loginResponse.includes("Invalid") ||
    loginResponse.includes("captcha") ||
    loginResponse.includes("error")
  ) {
    throw new Error("Login failed - wrong credentials or captcha");
  }

  // Quick validation
  const dashboardTest = await makeRequest("GET", "/agent/");
  if (dashboardTest.includes("login") || dashboardTest.includes("Please sign in")) {
    throw new Error("Login did not succeed - no session");
  }

  isLoggedIn = true;
  console.log("[LOGIN] OK");
}

/* ================= AUTO RE-LOGIN WRAPPER ================= */
async function ensureLogin() {
  if (isLoggedIn) return;

  try {
    await login();
  } catch (e) {
    console.error("[LOGIN ERROR]", e.message);
    throw e;
  }
}

/* ================= CHECK IF SESSION EXPIRED ================= */
function isSessionDead(body) {
  return (
    body.includes("Please sign in") ||
    body.includes("login") ||
    body.includes("Direct Script Access") ||
    body.includes("session") ||
    (body.length < 300 && body.includes("error"))
  );
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData.map((row) => [
    row[1] || "",
    "",
    row[3] || "",
    "Weekly",
    (row[4] || "").replace(/<[^>]*>/g, "").trim(),
    (row[7] || "").replace(/<[^>]*>/g, "").trim()
  ]);

  return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
  if (!data?.aaData) return data;

  data.aaData = data.aaData
    .map((row) => {
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

/* ================= GET NUMBERS ================= */
async function getNumbers() {
  await ensureLogin();

  const params = new URLSearchParams({
    frange: "",
    fclient: "",
    sEcho: "2",
    iDisplayStart: "0",
    iDisplayLength: "-1"
  }).toString();

  let body = await makeRequest(
    "GET",
    `/agent/res/data_smsnumbers.php?${params}`,
    null,
    {
      Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "XMLHttpRequest"
    }
  );

  if (isSessionDead(body)) {
    isLoggedIn = false;
    await ensureLogin();
    body = await makeRequest(
      "GET",
      `/agent/res/data_smsnumbers.php?${params}`,
      null,
      {
        Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
        "X-Requested-With": "XMLHttpRequest"
      }
    );
  }

  const json = safeJSON(body);
  return fixNumbers(json);
}

/* ================= GET SMS (today) ================= */
async function getSMS() {
  await ensureLogin();

  const now = new Date();
  const today = `\( {now.getFullYear()}- \){String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    fdate1: `${today} 00:00:00`,
    fdate2: `${today} 23:59:59`,
    frange: "",
    fclient: "",
    fnum: "",
    fcli: "",
    fg: "0",
    iDisplayLength: "-1"   // try -1, fallback to 5000 if fails
  }).toString();

  let body = await makeRequest(
    "GET",
    `/agent/res/data_smscdr.php?${params}`,
    null,
    {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,
      "X-Requested-With": "XMLHttpRequest"
    }
  );

  if (isSessionDead(body)) {
    isLoggedIn = false;
    await ensureLogin();
    body = await makeRequest(
      "GET",
      `/agent/res/data_smscdr.php?${params}`,
      null,
      {
        Referer: `${CONFIG.baseUrl}/agent/SMSCDRStats`,
        "X-Requested-With": "XMLHttpRequest"
      }
    );
  }

  const json = safeJSON(body);
  return fixSMS(json);
}

/* ================= ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers  or  ?type=sms" });
  }

  try {
    if (type === "numbers") {
      return res.json(await getNumbers());
    }
    if (type === "sms") {
      return res.json(await getSMS());
    }
    return res.json({ error: "Invalid type" });
  } catch (err) {
    console.error("[ERROR]", err.message);
    isLoggedIn = false;
    res.status(503).json({ error: "Service unavailable - " + err.message });
  }
});

module.exports = router;
