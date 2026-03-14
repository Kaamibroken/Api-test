const express = require("express");
const https   = require("https");
const zlib    = require("zlib");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL       = "https://www.ivasms.com";
const TERMINATION_ID = "1029603";
const USER_AGENT     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

/* ================= COOKIES (Update when expired) ================= */
// Jab expire ho: browser me login karo → DevTools → Network → koi bhi request
// → Request Headers → Cookie se XSRF-TOKEN aur ivas_sms_session copy karo
let TOKEN_CACHE = { value: null, time: 0 };
let COOKIES = {
  "XSRF-TOKEN":       "eyJpdiI6Imszazf0VEZPd0RlVFVpTityeGlwWmc9PSIsInZhbHVlIjoiNUY1YldvbnNHa3dlSmRnT2t1TDNoMVArTjZqT2UwLzJZZFA3MnB3SHUwOUl2Q05pYjlEd3cydGJTOTJBb1hsL1QvL3lJT05GTXJqb3RadEhHQVh6UWc5azJ6bTdNS2N0NGtOQ3oyQXU3V1FvYTFHL2lPaS9FYnROQkhoV1ZRL0UiLCJtYWMiOiJmYTg0MjI1MjY4MGU4YmY1ZTdhMmUzODIwMGI1ZmM1NTYxMmMyMzE1ZWZmMjkxYTI2Yzc4YmJhZWVlZmRjNmE3IiwidGFnIjoiIn0%3D",
  "ivas_sms_session": "eyJpdiI6InBueWx0SE1BNXJEZjlRL3hja3p1cHc9PSIsInZhbHVlIjoiS1dQWHk2QWd0V1dTUm93Y2RLWE8rOTJML1kweUtmZENCdzRZOEhoQVNyOXhGSEFNWmlZUTZ1ZFlMMkwzWjZxdWg2K2xUZW13L3F5ZEVVSThaY0duQmlRUGtvcEZGNURJVDMyT3YxK05KY0NCQUZpNDh2ZUJIa3Iwa0xIZXdzSlciLCJtYWMiOiIyZTFkMjc1ZmE1ZmRkZjg3NzE0ZjcyYWMwMGJjNGMwOWYzZjBhNmM1ODA2OTljMDM3YjM5ZjQwZDI4ZWE1YjQ1IiwidGFnIjoiIn0%3D"
};

/* ================= HELPERS ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function cookieString() {
  return Object.entries(COOKIES).map(([k,v]) => `${k}=${v}`).join("; ");
}

function getXsrf() {
  try { return decodeURIComponent(COOKIES["XSRF-TOKEN"] || ""); }
  catch { return COOKIES["XSRF-TOKEN"] || ""; }
}

function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

/* ================= TIMEOUT HELPER ================= */
function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/* ================= HTTP REQUEST ================= */
function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent":       USER_AGENT,
      "Accept":           "*/*",
      "Accept-Encoding":  "gzip, deflate, br",
      "Accept-Language":  "en-PK,en;q=0.9",
      "Cookie":           cookieString(),
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN":     getXsrf(),
      "X-CSRF-TOKEN":     getXsrf(),
      "Origin":           BASE_URL,
      "Referer":          `${BASE_URL}/portal`,
      ...extraHeaders
    };

    if (method === "POST" && body) {
      headers["Content-Type"]   = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = https.request(BASE_URL + path, { method, headers }, res => {
      // Auto-update cookies from response
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const sc = c.split(";")[0];
          const ki = sc.indexOf("=");
          if (ki > -1) {
            const k = sc.substring(0, ki).trim();
            const v = sc.substring(ki + 1).trim();
            if (k === "XSRF-TOKEN" || k === "ivas_sms_session") {
              COOKIES[k] = v;
            }
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
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch {}

        const text = buf.toString("utf-8");

        if (res.statusCode === 401 || res.statusCode === 419 ||
            text.includes('"message":"Unauthenticated"')) {
          return reject(new Error("SESSION_EXPIRED"));
        }

        resolve({ status: res.statusCode, body: text });
      });
    });

    // 15 second timeout
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timeout after 15s"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= FETCH _token FROM PORTAL ================= */
async function fetchToken() {
  // Cache token for 5 minutes
  if (TOKEN_CACHE.value && (Date.now() - TOKEN_CACHE.time) < 5 * 60 * 1000) {
    return TOKEN_CACHE.value;
  }
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/) ||
                resp.body.match(/"csrf-token"\s+content="([^"]+)"/);
  if (match) {
    TOKEN_CACHE.value = match[1];
    TOKEN_CACHE.time  = Date.now();
  }
  return match ? match[1] : null;
}

/* ================= PARSE HTML HELPERS ================= */
function stripHTML(html) {
  return (html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseNumbersHTML(html) {
  const results = [];
  // Extract range names
  const rangeMatches = html.matchAll(/toggleRange\(['"](.*?)['"]\s*,\s*['"](.*?)['"]/g);
  const ranges = {};
  for (const m of rangeMatches) {
    ranges[m[2]] = m[1]; // id -> name
  }

  // Extract numbers under each range
  const numberMatches = html.matchAll(/data-number="([^"]+)"[^>]*data-range="([^"]+)"|class="num[^"]*"[^>]*>([^<]+)<\/|<td[^>]*>([0-9]{6,15})<\/td>/g);

  // Simple: extract all phone numbers (6-15 digits)
  const phonePattern = /(\d{7,15})/g;
  const rangePattern = /toggleRange\(['"]([^'"]+)['"]/g;

  let rangeNames = [];
  let rm;
  while ((rm = rangePattern.exec(html)) !== null) {
    rangeNames.push(rm[1]);
  }

  // Get number rows - look for number containers
  const rowPattern = /class="num(?:ber)?[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td|tr)/g;
  let rowMatch;
  let idx = 0;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const text = stripHTML(rowMatch[1]);
    const nums = text.match(/\d{7,15}/g);
    if (nums) {
      nums.forEach(n => {
        results.push({
          number: n,
          range:  rangeNames[idx] || "",
          status: "Active"
        });
      });
      idx++;
    }
  }

  // Fallback: just extract all numbers from HTML
  if (results.length === 0) {
    const allNums = html.match(/\d{9,15}/g) || [];
    const unique  = [...new Set(allNums)];
    unique.forEach(n => results.push({ number: n, range: "", status: "Active" }));
  }

  return { total: results.length, aaData: results };
}

function parseSMSHTML(html) {
  const results = [];

  // Try JSON first
  try {
    const json = JSON.parse(html);
    if (json.data || json.aaData || Array.isArray(json)) return json;
  } catch {}

  // Parse HTML table rows
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row  = rowMatch[1];
    const cols = [];
    const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdPattern.exec(row)) !== null) {
      cols.push(stripHTML(tdMatch[1]));
    }
    if (cols.length >= 3) {
      results.push({
        date:    cols[0] || "",
        number:  cols[1] || "",
        message: cols[2] || "",
        status:  cols[3] || "",
        raw:     cols
      });
    }
  }

  return { total: results.length, aaData: results, rawPreview: results.length === 0 ? html.substring(0, 500) : undefined };
}

/* ================= GET NUMBERS ================= */
async function getNumbers(token) {
  const ts   = Date.now();
  const path = `/portal/numbers?draw=1`
    + `&columns[0][data]=number_id&columns[0][name]=id&columns[0][orderable]=false`
    + `&columns[1][data]=Number`
    + `&columns[2][data]=range`
    + `&columns[3][data]=A2P`
    + `&columns[4][data]=LimitA2P`
    + `&columns[5][data]=limit_cli_a2p`
    + `&columns[6][data]=limit_cli_did_a2p`
    + `&columns[7][data]=action&columns[7][searchable]=false&columns[7][orderable]=false`
    + `&order[0][column]=1&order[0][dir]=desc`
    + `&start=0&length=5000&search[value]=&_=${ts}`;

  const resp = await makeRequest("GET", path, null, null, {
    "Referer":      `${BASE_URL}/portal/numbers`,
    "Accept":       "application/json, text/javascript, */*; q=0.01",
    "X-CSRF-TOKEN": token
  });

  const json = safeJSON(resp.body);
  return fixNumbers(json);
}

function fixNumbers(json) {
  if (!json || !json.data) return json;

  // Format: [range, "", number, "Weekly", ""]
  const aaData = json.data.map(row => [
    row.range  || "",
    "",
    String(row.Number || ""),
    "Weekly",
    ""
  ]);

  return {
    sEcho:              2,
    iTotalRecords:      String(json.recordsTotal || aaData.length),
    iTotalDisplayRecords: String(json.recordsFiltered || aaData.length),
    aaData
  };
}

/* ================= GET SMS ================= */
async function getSMS(token) {
  const today    = getToday();
  const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
  const ua       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
    `--${boundary}--`
  ].join("\r\n");

  // Step 1: Get ranges
  const r1 = await makeRequest(
    "POST", "/portal/sms/received/getsms", parts,
    `multipart/form-data; boundary=${boundary}`,
    { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
  );

  const ranges = [...r1.body.matchAll(/toggleRange\('([^']+)'/g)].map(m => m[1]);

  // Step 2+3: All ranges parallel
  const rangeResults = await Promise.all(ranges.map(async range => {
    const b2 = `_token=${encodeURIComponent(token)}&start=${today}&end=${today}&range=${encodeURIComponent(range)}`;
    let r2;
    try {
      r2 = await withTimeout(makeRequest(
        "POST", "/portal/sms/received/getsms/number", b2,
        "application/x-www-form-urlencoded",
        { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
      ), 10000, "r2");
    } catch(e) { return []; }

    const numbers = [...r2.body.matchAll(/toggleNum[^(]+\('(\d+)'/g)].map(m => m[1]);

    // All numbers parallel
    const numResults = await Promise.all(numbers.map(async number => {
      const b3 = `_token=${encodeURIComponent(token)}&start=${today}&end=${today}&Number=${number}&Range=${encodeURIComponent(range)}`;
      try {
        const r3 = await withTimeout(makeRequest(
          "POST", "/portal/sms/received/getsms/number/sms", b3,
          "application/x-www-form-urlencoded",
          { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
        ), 10000, "r3");
        return parseSMSMessages(r3.body, range, number, today);
      } catch(e) { return []; }
    }));

    return numResults.flat();
  }));

  const allRows = rangeResults.flat();

  return {
    sEcho:                1,
    iTotalRecords:        String(allRows.length),
    iTotalDisplayRecords: String(allRows.length),
    aaData:               allRows
  };
}

function parseSMSMessages(html, range, number, date) {
  const rows = [];

  const decode = t => (t || "")
    .replace(/&lt;[^&]*&gt;/g, "")   // remove <#> <anything> encoded tags
    .replace(/&lt;/g, "").replace(/&gt;/g, "")
    .replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "")
    .replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

  const senderRe = /class="cli-tag"[^>]*>([^<]+)<\/span>/g;
  const senders  = [];
  let sm;
  while ((sm = senderRe.exec(html)) !== null) senders.push(sm[1].trim());

  const msgRe = /class="msg-text"[^>]*>([\s\S]*?)<\/div>/g;
  const msgs  = [];
  let mm;
  while ((mm = msgRe.exec(html)) !== null) msgs.push(decode(mm[1]));

  const timeRe = /class="time-cell"[^>]*>\s*(\d{2}:\d{2}:\d{2})\s*</g;
  const times  = [];
  let tm;
  while ((tm = timeRe.exec(html)) !== null) times.push(tm[1]);

  msgs.forEach((msg, i) => {
    if (!msg) return;
    rows.push([
      `${date} ${times[i] || "00:00:00"}`,
      range, number,
      senders[i] || "SMS",
      msg, "$", 0
    ]);
  });

  return rows;
}

/* ================= GET NUMBERS ================= */
async function getNumbers(token) {
  const ts   = Date.now();
  const path = `/portal/numbers?draw=1`
    + `&columns[0][data]=number_id&columns[0][name]=id&columns[0][orderable]=false`
    + `&columns[1][data]=Number`
    + `&columns[2][data]=range`
    + `&columns[3][data]=A2P`
    + `&columns[4][data]=LimitA2P`
    + `&columns[5][data]=limit_cli_a2p`
    + `&columns[6][data]=limit_cli_did_a2p`
    + `&columns[7][data]=action&columns[7][searchable]=false&columns[7][orderable]=false`
    + `&order[0][column]=1&order[0][dir]=desc`
    + `&start=0&length=5000&search[value]=&_=${ts}`;

  const resp = await makeRequest("GET", path, null, null, {
    "Referer":      `${BASE_URL}/portal/numbers`,
    "Accept":       "application/json, text/javascript, */*; q=0.01",
    "X-CSRF-TOKEN": token
  });

  const json = safeJSON(resp.body);
  return fixNumbers(json);
}

function fixNumbers(json) {
  if (!json || !json.data) return json;

  // Format: [range, "", number, "Weekly", ""]
  const aaData = json.data.map(row => [
    row.range  || "",
    "",
    String(row.Number || ""),
    "Weekly",
    ""
  ]);

  return {
    sEcho:              2,
    iTotalRecords:      String(json.recordsTotal || aaData.length),
    iTotalDisplayRecords: String(json.recordsFiltered || aaData.length),
    aaData
  };
}

/* ================= GET SMS ================= */


/* ================= ROUTES ================= */

// Main API
router.get("/", async (req, res) => {
  const { type } = req.query;
  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    const token = await fetchToken();
    if (!token) {
      return res.status(401).json({
        error: "Session expired",
        fix:   "POST /api/ivasms/update-session with xsrf and session cookies"
      });
    }

    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms")     return res.json(await getSMS(token));

    res.json({ error: "Invalid type. Use numbers or sms" });

  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      return res.status(401).json({
        error: "Session expired — update cookies",
        fix:   "POST /api/ivasms/update-session with xsrf and session"
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Raw debug: show actual OTP SMS HTML (level 3)
router.get("/raw-sms", async (req, res) => {
  try {
    const token    = await fetchToken();
    const today    = getToday();
    const ua       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
    const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
      `--${boundary}--`
    ].join("\r\n");
    // Level 1
    const r1 = await makeRequest("POST", "/portal/sms/received/getsms", parts,
      `multipart/form-data; boundary=${boundary}`,
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    const rangeMatch = r1.body.match(/toggleRange\('([^']+)'/);
    if (!rangeMatch) return res.send("No ranges:\n" + r1.body.substring(0,1000));
    const range = rangeMatch[1];
    // Level 2
    const r2 = await makeRequest("POST", "/portal/sms/received/getsms/number",
      new URLSearchParams({ _token: token, start: today, end: today, range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    const numMatch = r2.body.match(/toggleNum[^(]+\('(\d+)'/);
    if (!numMatch) return res.send(`Range: ${range}\nNo numbers:\n` + r2.body.substring(0,1000));
    const number = numMatch[1];
    // Level 3
    const r3 = await makeRequest("POST", "/portal/sms/received/getsms/number/sms",
      new URLSearchParams({ _token: token, start: today, end: today, Number: number, Range: range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    res.set("Content-Type", "text/plain");
    res.send(`Range: ${range}\nNumber: ${number}\n\n` + r3.body.substring(0, 5000));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cookie update endpoint — POST with JSON body
// { "xsrf": "...", "session": "..." }
router.post("/update-session", express.json(), (req, res) => {
  const { xsrf, session } = req.body || {};
  if (!xsrf || !session) {
    return res.status(400).json({
      error: "Required: xsrf and session",
      example: { xsrf: "XSRF-TOKEN value", session: "ivas_sms_session value" }
    });
  }
  COOKIES["XSRF-TOKEN"]       = xsrf;
  COOKIES["ivas_sms_session"] = session;
  TOKEN_CACHE.value = null; // reset token cache
  res.json({ success: true, message: "Cookies updated!" });
});

// Check session status
router.get("/status", async (req, res) => {
  try {
    const token = await fetchToken();
    res.json({
      status:    token ? "✅ Session active" : "❌ Session expired",
      hasToken:  !!token,
      cookieKeys: Object.keys(COOKIES)
    });
  } catch (e) {
    res.json({ status: "❌ Session expired", error: e.message });
  }
});

module.exports = router;
