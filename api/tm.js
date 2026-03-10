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
let lastCapt = 4;
let sessionData = {
  phpsessid: null,
  lastActivity: null
};

/* SAFE JSON */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server", rawPreview: text.substring(0, 300) };
  }
}

/* REQUEST - Enhanced with better headers */
function makeRequest(method, path, data = null, extraHeaders = {}, isAjax = false) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;
    const urlObj = new URL(fullUrl);
    const httpModule = urlObj.protocol === 'https:' ? https : http;

    console.log(`[REQ] ${method} ${fullUrl}`);

    // Base headers - exactly like browser
    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": isAjax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Cookie": cookies.join("; "),
      "Host": urlObj.hostname,
      "sec-ch-ua": '"Not:A-Brand";v="99", "Android WebView";v="145", "Chromium";v="145"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "Upgrade-Insecure-Requests": isAjax ? undefined : "1",
      ...extraHeaders
    };

    // Clean undefined headers
    Object.keys(headers).forEach(key => headers[key] === undefined && delete headers[key]);

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
      headers["X-Requested-With"] = "mark.via.gp";
    }

    if (isAjax) {
      headers["X-Requested-With"] = "mark.via.gp";
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
      // Store cookies properly
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const cookie = c.split(";")[0];
          if (!cookies.some(existing => existing.startsWith(cookie.split('=')[0]))) {
            cookies.push(cookie);
            
            // Extract PHPSESSID
            if (cookie.startsWith('PHPSESSID=')) {
              sessionData.phpsessid = cookie.split('=')[1];
              sessionData.lastActivity = Date.now();
            }
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));

      res.on("end", () => {
        let buffer = Buffer.concat(chunks);
        
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") {
          try { buffer = zlib.gunzipSync(buffer); } catch {}
        } else if (encoding === "deflate") {
          try { buffer = zlib.inflateSync(buffer); } catch {}
        } else if (encoding === "br") {
          try { if (zlib.brotliDecompressSync) buffer = zlib.brotliDecompressSync(buffer); } catch {}
        }
        
        const responseText = buffer.toString();
        
        // Check for direct script access
        if (responseText.includes("Direct Script Access")) {
          console.log("[WARN] Direct Script Access blocked");
        }
        
        resolve(responseText);
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* LOGIN - Enhanced */
async function login(force = false) {
  if (isLoggedIn && !force) return true;
  
  cookies = [];
  isLoggedIn = false;

  try {
    console.log("[LOGIN] Starting...");
    
    // Step 1: Visit main page first
    await makeRequest("GET", "/", null, {
      "Accept": "text/html"
    });
    
    // Step 2: Get sign-in page
    const page = await makeRequest("GET", "/sign-in", null, {
      "Accept": "text/html"
    });

    // Extract CAPTCHA
    let capt = lastCapt;
    const match = page.match(/What is (\d+)\s*\+\s*(\d+)/i) ||
                  page.match(/captcha.*?(\d+).*?(\d+)/i);
    
    if (match && match[1] && match[2]) {
      capt = Number(match[1]) + Number(match[2]);
    }

    console.log("[LOGIN] Using CAPTCHA:", capt);
    lastCapt = capt;

    // Step 3: Submit login
    const form = querystring.stringify({
      username: CONFIG.username,
      password: CONFIG.password,
      capt: capt
    });

    const loginResult = await makeRequest("POST", "/signin", form, {
      "Referer": `${CONFIG.baseUrl}/sign-in`,
      "Accept": "text/html"
    });

    // Step 4: Verify login - visit agent page
    const agentPage = await makeRequest("GET", "/agent/", null, {
      "Referer": `${CONFIG.baseUrl}/sign-in`,
      "Accept": "text/html"
    });
    
    if (agentPage.includes("SMSDashboard") || agentPage.includes("MySMSNumbers")) {
      isLoggedIn = true;
      console.log("[LOGIN] Success!");
      
      // Step 5: Load necessary pages to establish session
      await makeRequest("GET", "/agent/SMSDashboard", null, {
        "Referer": `${CONFIG.baseUrl}/agent/`,
        "Accept": "text/html"
      });
      
      return true;
    } else {
      throw new Error("Login failed - Invalid credentials");
    }
  } catch (error) {
    console.log("[LOGIN] Error:", error.message);
    throw error;
  }
}

/* FIX NUMBERS */
function fixNumbers(data) {
  if (!data || !data.aaData) return data;
  
  data.aaData = data.aaData.map(row => [
    row[1] || "",        // Number
    "",                  // Empty
    row[2] || "",        // Client
    "Weekly",            // Type
    (row[4] || "").replace(/<[^>]+>/g, "").trim(),  // Status
    (row[5] || "").replace(/<[^>]+>/g, "").trim()   // Expiry
  ]);
  
  return data;
}

/* FIX SMS */
function fixSMS(data) {
  if (!data || !data.aaData) return data;
  
  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      if (!message) return null;
      
      return [
        row[0] || "",     // Date
        row[1] || "",     // From
        row[2] || "",     // To
        row[3] || "",     // Client
        message,          // Message
        "$",              // Currency
        row[7] || 0       // Status
      ];
    })
    .filter(Boolean);
  
  return data;
}

/* GET NUMBERS - Fixed sequence */
async function getNumbers() {
  if (!isLoggedIn) await login();

  try {
    // CRITICAL: First visit the MySMSNumbers page
    console.log("[NUMBERS] Loading MySMSNumbers page...");
    await makeRequest("GET", "/agent/MySMSNumbers", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`,
      "Accept": "text/html"
    });

    // Small delay to simulate browser behavior
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Now fetch the data
    console.log("[NUMBERS] Fetching data...");
    
    const params = {
      frange: "",
      fclient: "",
      fnumber: "",
      sEcho: "2",
      iColumns: "8",
      iDisplayStart: "0",
      iDisplayLength: "-1",
      sSearch: "",
      bRegex: "false",
      iSortCol_0: "0",
      sSortDir_0: "asc",
      iSortingCols: "1",
      _: Date.now()
    };

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${queryString}`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "Accept": "application/json, text/javascript, */*; q=0.01"
    }, true); // isAjax = true

    // Check if still getting direct script access
    if (data.includes("Direct Script Access")) {
      console.log("[NUMBERS] Direct Script Access - retrying with full sequence...");
      
      // Reload everything
      await login(true);
      await makeRequest("GET", "/agent/MySMSNumbers", null, {
        "Referer": `${CONFIG.baseUrl}/agent/`
      });
      
      // Try again
      const retryData = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${queryString}`, null, {
        "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
        "Accept": "application/json, text/javascript, */*; q=0.01"
      }, true);
      
      return fixNumbers(safeJSON(retryData));
    }

    return fixNumbers(safeJSON(data));
    
  } catch (error) {
    console.log("[NUMBERS Error]", error.message);
    throw error;
  }
}

/* GET SMS - Fixed sequence */
async function getSMS() {
  if (!isLoggedIn) await login();

  try {
    // CRITICAL: First visit SMSCDRReports page
    console.log("[SMS] Loading SMSCDRReports page...");
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`,
      "Accept": "text/html"
    });

    // Also load stats page (as in your capture)
    await makeRequest("GET", "/agent/SMSCDRStats", null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "Accept": "text/html"
    }).catch(() => {});

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Wide date range
    const startDate = "2026-01-01";
    const endDate = "2099-12-31";

    console.log("[SMS] Wide range:", startDate, "to", endDate);

    const params = {
      fdate1: `${startDate} 00:00:00`,
      fdate2: `${endDate} 23:59:59`,
      frange: "",
      fclient: "",
      fnum: "",
      fcli: "",
      fg: "0",
      sEcho: "2",
      iColumns: "9",
      iDisplayStart: "0",
      iDisplayLength: "2000",
      sSearch: "",
      bRegex: "false",
      iSortCol_0: "0",
      sSortDir_0: "desc",
      iSortingCols: "1",
      _: Date.now()
    };

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `/agent/res/data_smscdr.php?${queryString}`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "Accept": "application/json, text/javascript, */*; q=0.01"
    }, true);

    // Check for direct script access
    if (data.includes("Direct Script Access")) {
      console.log("[SMS] Direct Script Access - retrying...");
      
      // Full retry sequence
      await login(true);
      await makeRequest("GET", "/agent/SMSCDRReports");
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const retryData = await makeRequest("GET", `/agent/res/data_smscdr.php?${queryString}`, null, {
        "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
        "Accept": "application/json, text/javascript, */*; q=0.01"
      }, true);
      
      const json = safeJSON(retryData);
      const result = fixSMS(json);
      console.log("[SMS] Final count:", result.aaData?.length || 0);
      return result;
    }

    const json = safeJSON(data);
    const result = fixSMS(json);
    console.log("[SMS] Final count:", result.aaData?.length || 0);
    return result;
    
  } catch (error) {
    console.log("[SMS Error]", error.message);
    throw error;
  }
}

/* GET SMS by date */
async function getSMSByDate(dateFrom, dateTo) {
  if (!isLoggedIn) await login();

  try {
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`
    });

    const params = {
      fdate1: dateFrom,
      fdate2: dateTo,
      frange: "",
      fclient: "",
      fnum: "",
      fcli: "",
      fg: "0",
      sEcho: "2",
      iColumns: "9",
      iDisplayStart: "0",
      iDisplayLength: "2000",
      iSortCol_0: "0",
      sSortDir_0: "desc",
      _: Date.now()
    };

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `/agent/res/data_smscdr.php?${queryString}`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "Accept": "application/json, text/javascript, */*; q=0.01"
    }, true);

    const json = safeJSON(data);
    return fixSMS(json);
    
  } catch (error) {
    console.log("[SMS Date Error]", error.message);
    throw error;
  }
}

/* ROUTES */
router.get("/", async (req, res) => {
  const { type, dateFrom, dateTo } = req.query;

  if (!type) {
    return res.json({ 
      error: "Use ?type=numbers or ?type=sms",
      example: "?type=numbers or ?type=sms"
    });
  }

  try {
    let result;
    
    if (type === "numbers") {
      result = await getNumbers();
    } 
    else if (type === "sms") {
      if (dateFrom && dateTo) {
        const from = `${dateFrom} 00:00:00`;
        const to = `${dateTo} 23:59:59`;
        result = await getSMSByDate(from, to);
      } else {
        result = await getSMS();
      }
    }
    else {
      return res.json({ error: "Invalid type" });
    }

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
      type: type,
      note: "Try visiting website manually first to establish session"
    });
  }
});

/* Enhanced status */
router.get("/status", async (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    cookies: cookies.length,
    phpsessid: sessionData.phpsessid,
    lastActivity: sessionData.lastActivity,
    username: CONFIG.username
  });
});

/* Force re-login */
router.post("/relogin", async (req, res) => {
  try {
    await login(true);
    res.json({ 
      success: true, 
      message: "Re-login successful",
      session: sessionData
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* Test endpoint */
router.get("/test", async (req, res) => {
  try {
    // Test direct access
    const test = await makeRequest("GET", "/agent/res/data_smsnumbers.php", null, {}, true);
    res.json({
      preview: test.substring(0, 200),
      includes_block: test.includes("Direct Script Access")
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
