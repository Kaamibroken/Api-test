const express = require("express");
const https   = require("https");
const zlib    = require("zlib");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL       = "https://www.ivasms.com";
const TERMINATION_ID = "1029603"; // From your captured request

// Update these cookies when session expires
let COOKIES = {
  "XSRF-TOKEN":       "eyJpdiI6Ijl0YUl5UVdCNExRVTNqdWRYVXZjVlE9PSIsInZhbHVlIjoiQVNHM2pEMTZFd0pIeUNNcTFoclV1YityNFVzM3Vpd2JhT0REM3pZZWxsOFlPY29ySUJZQ0VzOGlNM20wRmUyU3Bad3kxNDBDcWR3Q2E3cktTS2RmUmdKRmlQMkVHZ3U3OGVPQkgwSkN2cHZ3UitmL1hpc2pBRk4rSm5qbHJMcysiLCJtYWMiOiI5N2U5NjcxYjFhMjdjNzhhOTBkMjhjMzljNmVjNjkwZDM0YmZmYjkzNzk1NDgxNzc0ZDRmNjU3MWFkNTNkOWI0IiwidGFnIjoiIn0%3D",
  "ivas_sms_session": "eyJpdiI6InJOWTAwTWF4SnlIbFZqdlNyU1dVeGc9PSIsInZhbHVlIjoiMWs5cmQwZ09sNG5tK0JzaTZMRzdua0YrS3Myb29kSFQxQXF4b0V4aGZ3NERNUEFnZGt5Uk5nSk5ocTJlbCtOSzJ3Z29EQUFpNHYxNkVZWS9DQzRxYS9zTjZraE05Z3R4MDl4aUw2MnRDOHg1NkFFck9saUNhWkI3L1VlcUk2SzIiLCJtYWMiOiJkZmM5ZmZmNWFhMjZjMmMxNWYwNzdhNDcxNDUyZDg2NGRlZjI5Nzc5NTkxNTJiZGZhYzQyMTU0Y2VmYmE1NGE1IiwidGFnIjoiIn0%3D"
};

const USER_AGENT = "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.159 Mobile Safari/537.36";

/* ================= GET TODAY DATE ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/* ================= COOKIE STRING ================= */
function getCookieString() {
  return Object.entries(COOKIES).map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ================= XSRF TOKEN (decoded) ================= */
function getXsrfHeader() {
  try {
    return decodeURIComponent(COOKIES["XSRF-TOKEN"]);
  } catch {
    return COOKIES["XSRF-TOKEN"];
  }
}

/* ================= HTTP REQUEST ================= */
function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = BASE_URL + path;
    const isPost  = method === "POST";

    const headers = {
      "User-Agent":      USER_AGENT,
      "Accept":          "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9",
      "Cookie":          getCookieString(),
      "X-Requested-With":"XMLHttpRequest",
      "Referer":         `${BASE_URL}/portal`,
      "Origin":          BASE_URL,
      "X-XSRF-TOKEN":    getXsrfHeader(),
      ...extraHeaders
    };

    if (isPost && body) {
      headers["Content-Type"]   = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = https.request(fullUrl, { method, headers }, res => {
      // Save updated cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const [kv] = c.split(";");
          const [k, ...v] = kv.split("=");
          if (k && (k.trim() === "XSRF-TOKEN" || k.trim() === "ivas_sms_session")) {
            COOKIES[k.trim()] = v.join("=").trim();
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br")   buf = zlib.brotliDecompressSync(buf);
        } catch {}

        const text = buf.toString("utf-8");

        // Session expired check
        if (res.statusCode === 302 || text.includes('"message":"Unauthenticated"') || text.includes("login")) {
          return reject(new Error("SESSION_EXPIRED"));
        }

        resolve({ status: res.statusCode, body: text });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

/* ================= GET _token FROM PORTAL PAGE ================= */
async function fetchToken() {
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

/* ================= GET NUMBERS ================= */
async function getNumbers(token) {
  const body = `termination_id=${TERMINATION_ID}&_token=${token}`;

  const resp = await makeRequest(
    "POST",
    "/portal/live/getNumbers",
    body,
    "application/x-www-form-urlencoded; charset=UTF-8",
    { "Referer": `${BASE_URL}/portal/live/my_sms` }
  );

  return safeJSON(resp.body);
}

/* ================= GET SMS ================= */
async function getSMS(token) {
  const today    = getToday();
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2, 18).toUpperCase();

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
    `--${boundary}--`
  ].join("\r\n");

  const resp = await makeRequest(
    "POST",
    "/portal/sms/received/getsms",
    parts,
    `multipart/form-data; boundary=${boundary}`,
    {
      "Referer":    `${BASE_URL}/portal/sms/received`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
      "Accept":     "text/html, */*; q=0.01"
    }
  );

  return safeJSON(resp.body);
}

/* ================= ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    // Fetch _token from portal page
    const token = await fetchToken();
    if (!token) return res.status(401).json({ error: "Session expired — update COOKIES in ivasms.js" });

    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms")     return res.json(await getSMS(token));

    res.json({ error: "Invalid type" });

  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      return res.status(401).json({ error: "Session expired — update COOKIES in ivasms.js" });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
