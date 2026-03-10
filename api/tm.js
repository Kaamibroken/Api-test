const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "https://www.konektapremium.net",
  username: "kami526",
  password: "kami526",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;
let lastCapt = 4; // From your capture

/* SAFE JSON */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server", rawPreview: text.substring(0, 300) };
  }
}

/* REQUEST - Same as timesms pattern */
function makeRequest(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;
    
    // Parse URL for HTTPS
    const urlObj = new URL(fullUrl);
    const httpModule = urlObj.protocol === 'https:' ? https : http;

    console.log(`[REQ] ${method} ${fullUrl}`);

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9",
      "Cookie": cookies.join("; "),
      "sec-ch-ua": '"Not:A-Brand";v="99", "Android WebView";v="145", "Chromium";v="145"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
    }

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
      port: urlObj.protocol === 'https:' ? 443 : 80,
      rejectUnauthorized: false
    };

    const req = httpModule.request(options, res => {
      // Store cookies
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
        
        // Handle compression
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") {
          try { buffer = zlib.gunzipSync(buffer); } catch {}
        } else if (encoding === "deflate") {
          try { buffer = zlib.inflateSync(buffer); } catch {}
        } else if (encoding === "br") {
          try { if (zlib.brotliDecompressSync) buffer = zlib.brotliDecompressSync(buffer); } catch {}
        }
        
        resolve(buffer.toString());
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* LOGIN - Same pattern as timesms */
async function login() {
  cookies = [];
  isLoggedIn = false;

  // Get sign-in page
  const page = await makeRequest("GET", "/sign-in", null, {
    "Accept": "text/html"
  });

  // Extract CAPTCHA - from your capture it was "4"
  // But if dynamic, try to find
  let capt = lastCapt;
  
  // Try to find CAPTCHA question
  const match = page.match(/What is (\d+)\s*\+\s*(\d+)/i) ||
                page.match(/captcha.*?(\d+).*?(\d+)/i) ||
                page.match(/name="capt".*?value="?(\d+)"?/i);
  
  if (match) {
    if (match[1] && match[2]) {
      capt = Number(match[1]) + Number(match[2]);
    } else if (match[1]) {
      capt = match[1];
    }
  }

  console.log("[LOGIN] Using CAPTCHA:", capt);
  lastCapt = capt;

  // Submit login form
  const form = querystring.stringify({
    username: CONFIG.username,
    password: CONFIG.password,
    capt: capt
  });

  await makeRequest("POST", "/signin", form, {
    Referer: `${CONFIG.baseUrl}/sign-in`,
    "X-Requested-With": "mark.via.gp"
  });

  // Verify login
  const test = await makeRequest("GET", "/agent/", null, {
    Referer: `${CONFIG.baseUrl}/sign-in`
  });
  
  if (test.includes("Please sign in") || test.includes("login") || test.includes("sign-in")) {
    throw new Error("Login failed");
  }

  isLoggedIn = true;
  console.log("[LOGIN] Success");
}

/* FIX NUMBERS - Same as timesms pattern */
function fixNumbers(data) {
  if (!data.aaData) return data;
  
  data.aaData = data.aaData.map(row => [
    row[1] || "",        // Number
    "",                  // Empty (like timesms)
    row[2] || "",        // Client
    "Weekly",            // Fixed type
    (row[4] || "").replace(/<[^>]+>/g, "").trim(),  // Status
    (row[5] || "").replace(/<[^>]+>/g, "").trim()   // Expiry
  ]);
  
  return data;
}

/* FIX SMS - Same as timesms pattern */
function fixSMS(data) {
  if (!data.aaData) return data;
  
  data.aaData = data.aaData
    .map(row => {
      // Clean message - remove legendhacker
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      
      // Skip empty messages
      if (!message) return null;
      
      return [
        row[0] || "",     // Date/Time
        row[1] || "",     // From Number
        row[2] || "",     // To Number  
        row[3] || "",     // Client
        message,          // Clean message
        "$",              // Currency symbol (like timesms)
        row[7] || 0       // Status/Cost
      ];
    })
    .filter(Boolean);     // Remove null entries
  
  return data;
}

/* GET NUMBERS - Same pattern */
async function getNumbers() {
  if (!isLoggedIn) await login();

  // First load numbers page
  await makeRequest("GET", "/agent/MySMSNumbers", null, {
    Referer: `${CONFIG.baseUrl}/agent/`
  });

  // Build parameters - exactly like timesms but with full params from capture
  const params = querystring.stringify({
    frange: "",
    fclient: "",
    fnumber: "",
    sEcho: "2",
    iColumns: "8",
    sColumns: ",,,,,,,",
    iDisplayStart: "0",
    iDisplayLength: "-1",
    sSearch: "",
    bRegex: "false",
    iSortCol_0: "0",
    sSortDir_0: "asc",
    iSortingCols: "1",
    _: Date.now()
  });

  let data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${params}`, null, {
    Referer: `${CONFIG.baseUrl}/agent/MySMSNumbers`,
    "X-Requested-With": "mark.via.gp"
  });

  return fixNumbers(safeJSON(data));
}

/* GET SMS - Same wide range pattern as timesms */
async function getSMS() {
  if (!isLoggedIn) await login();

  // Wide date range (your pattern from timesms)
  const startDate = "2026-01-01";  // Can adjust as needed
  const endDate = "2099-12-31";

  console.log("[SMS] Wide range:", startDate, "to", endDate);

  // Build URL with parameters
  const params = [
    `fdate1=${encodeURIComponent(startDate + " 00:00:00")}`,
    `fdate2=${encodeURIComponent(endDate + " 23:59:59")}`,
    `frange=`,
    `fclient=`,
    `fnum=`,
    `fcli=`,
    `fgdate=`,
    `fgmonth=`,
    `fgrange=`,
    `fgclient=`,
    `fgnumber=`,
    `fgcli=`,
    `fg=0`,
    `sEcho=2`,
    `iColumns=9`,
    `sColumns=,,,,,,,,`,
    `iDisplayStart=0`,
    `iDisplayLength=2000`,  // Your suggested value
    `sSearch=`,
    `bRegex=false`,
    `iSortCol_0=0`,
    `sSortDir_0=desc`,
    `iSortingCols=1`,
    `_=${Date.now()}`
  ].join('&');

  const urlPath = `/agent/res/data_smscdr.php?${params}`;

  console.log("[SMS] Full URL:", CONFIG.baseUrl + urlPath);

  // Load parent page first (like timesms)
  try {
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      Referer: `${CONFIG.baseUrl}/agent/`
    });
    console.log("[SMS] Loaded SMSCDRReports");
    
    // Also load stats page (from your capture)
    await makeRequest("GET", "/agent/SMSCDRStats", null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`
    }).catch(() => {});
    
  } catch (err) {
    console.warn("[SMS] Parent page load failed:", err.message);
  }

  // Get SMS data
  let data = await makeRequest("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "mark.via.gp",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  });

  console.log("[SMS RAW PREVIEW]", data.substring(0, 500));

  // Retry if blocked (like timesms)
  if (data.includes("Direct Script Access") || 
      data.includes("Please sign in") || 
      data.includes("login") ||
      data.includes("sign-in")) {
    
    console.log("[SMS] Blocked - retrying...");
    await login();
    
    // Reload parent page
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      Referer: `${CONFIG.baseUrl}/agent/`
    });
    
    // Retry data fetch
    data = await makeRequest("GET", urlPath, null, {
      Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "mark.via.gp"
    });
    
    console.log("[SMS RETRY PREVIEW]", data.substring(0, 500));
  }

  const json = safeJSON(data);
  const result = fixSMS(json);

  console.log("[SMS] Final messages count:", result.aaData?.length || 0);

  return result;
}

/* GET SMS with date range - Optional enhancement */
async function getSMSByDate(dateFrom, dateTo) {
  if (!isLoggedIn) await login();

  console.log("[SMS] Date range:", dateFrom, "to", dateTo);

  const params = [
    `fdate1=${encodeURIComponent(dateFrom)}`,
    `fdate2=${encodeURIComponent(dateTo)}`,
    `frange=`,
    `fclient=`,
    `fnum=`,
    `fcli=`,
    `fg=0`,
    `sEcho=2`,
    `iColumns=9`,
    `iDisplayStart=0`,
    `iDisplayLength=2000`,
    `iSortCol_0=0`,
    `sSortDir_0=desc`,
    `_=${Date.now()}`
  ].join('&');

  const urlPath = `/agent/res/data_smscdr.php?${params}`;

  // Load parent page
  await makeRequest("GET", "/agent/SMSCDRReports", null, {
    Referer: `${CONFIG.baseUrl}/agent/`
  }).catch(() => {});

  let data = await makeRequest("GET", urlPath, null, {
    Referer: `${CONFIG.baseUrl}/agent/SMSCDRReports`,
    "X-Requested-With": "mark.via.gp"
  });

  const json = safeJSON(data);
  return fixSMS(json);
}

/* MAIN ROUTE - Same as timesms */
router.get("/", async (req, res) => {
  const { type, dateFrom, dateTo } = req.query;

  if (!type) {
    return res.json({ 
      error: "Use ?type=numbers or ?type=sms",
      example: "?type=numbers or ?type=sms or ?type=sms&dateFrom=2026-03-10&dateTo=2026-03-10"
    });
  }

  try {
    let result;
    
    if (type === "numbers") {
      result = await getNumbers();
    } 
    else if (type === "sms") {
      // Check if date range provided
      if (dateFrom && dateTo) {
        const from = `${dateFrom} 00:00:00`;
        const to = `${dateTo} 23:59:59`;
        result = await getSMSByDate(from, to);
      } else {
        result = await getSMS(); // Wide range
      }
    }
    else {
      return res.json({ error: "Invalid type" });
    }

    // Add metadata
    res.json({
      success: true,
      type: type,
      count: result.aaData?.length || 0,
      data: result
    });

  } catch (err) {
    console.error("[ERROR]", err.message);
    res.json({ 
      success: false,
      error: err.message || "Failed",
      type: type 
    });
  }
});

/* Status endpoint */
router.get("/status", async (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    cookies: cookies.length,
    username: CONFIG.username
  });
});

/* Force re-login */
router.post("/relogin", async (req, res) => {
  try {
    await login();
    res.json({ success: true, message: "Re-login successful" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
