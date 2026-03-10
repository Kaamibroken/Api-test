const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "https://www.konektapremium.net", // HTTPS use kiya
  username: "kami526",  // Aapke capture se
  password: "kami526",  // Aapke capture se
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

let cookies = [];
let isLoggedIn = false;
let lastCaptchaValue = 4; // Default from your capture

/* SAFE JSON PARSER */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { 
      error: "Invalid JSON from server", 
      rawPreview: text?.substring(0, 300) || "Empty response" 
    };
  }
}

/* REQUEST MAKER - HTTP/HTTPS both support */
function makeRequest(method, path, data = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;
    
    // Parse URL to decide http vs https
    const urlObj = new URL(fullUrl);
    const httpModule = urlObj.protocol === 'https:' ? https : http;

    console.log(`[REQ] ${method} ${fullUrl}`);

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Cookie": cookies.join("; "),
      "sec-ch-ua": '"Not:A-Brand";v="99", "Android WebView";v="145", "Chromium";v="145"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "Upgrade-Insecure-Requests": "1",
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
      headers["X-Requested-With"] = "mark.via.gp";
    }

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
      port: urlObj.protocol === 'https:' ? 443 : 80,
      rejectUnauthorized: false // For self-signed certs if any
    };

    const req = httpModule.request(options, res => {
      // Store cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const cookie = c.split(";")[0];
          if (!cookies.some(existing => existing.startsWith(cookie.split('=')[0]))) {
            cookies.push(cookie);
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));

      res.on("end", () => {
        let buffer = Buffer.concat(chunks);
        
        // Handle different encodings
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") {
          try { buffer = zlib.gunzipSync(buffer); } catch (e) { 
            console.log("[GZIP Error]", e.message);
          }
        } else if (encoding === "deflate") {
          try { buffer = zlib.inflateSync(buffer); } catch (e) { }
        } else if (encoding === "br") {
          // Brotli - Node.js v11.7.0+ required
          try { 
            if (zlib.brotliDecompressSync) {
              buffer = zlib.brotliDecompressSync(buffer); 
            }
          } catch (e) { }
        }
        
        resolve(buffer.toString());
      });
    });

    req.on("error", err => {
      console.log("[Request Error]", err.message);
      reject(err);
    });
    
    if (data) req.write(data);
    req.end();
  });
}

/* LOGIN FUNCTION - Exact match of your capture */
async function login(force = false) {
  if (isLoggedIn && !force) return true;
  
  cookies = []; // Clear cookies for fresh login
  isLoggedIn = false;

  try {
    console.log("[LOGIN] Starting login process...");
    
    // Step 1: Get sign-in page with PHPSESSID
    const loginPage = await makeRequest("GET", "/sign-in", null, {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    });
    
    // Step 2: Extract CAPTCHA - From your capture it was "4"
    // But if dynamic, we can try to parse
    let captchaValue = lastCaptchaValue;
    
    // Try to extract if dynamic (optional)
    const captchaMatch = loginPage.match(/name="capt".*?value="?(\d+)"?/i) || 
                        loginPage.match(/captcha.*?(\d+)/i);
    if (captchaMatch) {
      captchaValue = captchaMatch[1];
    }
    
    console.log(`[LOGIN] Using CAPTCHA: ${captchaValue}`);
    
    // Step 3: Submit login form - exactly as your capture
    const formData = querystring.stringify({
      username: CONFIG.username,
      password: CONFIG.password,
      capt: captchaValue
    });

    const loginResult = await makeRequest("POST", "/signin", formData, {
      "Referer": `${CONFIG.baseUrl}/sign-in`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "mark.via.gp"
    });

    // Step 4: Verify login by accessing agent page
    const agentPage = await makeRequest("GET", "/agent/", null, {
      "Referer": `${CONFIG.baseUrl}/sign-in`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    });

    // Check if login successful
    if (agentPage.includes("SMSDashboard") || agentPage.includes("MySMSNumbers")) {
      isLoggedIn = true;
      lastCaptchaValue = captchaValue;
      console.log("[LOGIN] Success! Session established");
      
      // Load dashboard for good measure
      await makeRequest("GET", "/agent/SMSDashboard", null, {
        "Referer": `${CONFIG.baseUrl}/agent/`
      }).catch(() => {});
      
      return true;
    } else {
      throw new Error("Login failed - Invalid credentials or CAPTCHA");
    }
  } catch (error) {
    console.log("[LOGIN] Error:", error.message);
    isLoggedIn = false;
    throw error;
  }
}

/* DATA CLEANING - Numbers */
function cleanNumbersData(data) {
  if (!data || !data.aaData) return data;
  
  // Clean up HTML tags and format nicely
  data.aaData = data.aaData.map(row => {
    // Based on your capture structure
    return {
      id: row[0] || "",
      number: row[1] || "",
      client: row[2] || "",
      type: row[3] || "",
      status: (row[4] || "").replace(/<[^>]+>/g, "").trim(),
      expiry: (row[5] || "").replace(/<[^>]+>/g, "").trim(),
      sms_count: row[6] || 0,
      actions: (row[7] || "").replace(/<[^>]+>/g, "").trim()
    };
  });
  
  return data;
}

/* DATA CLEANING - SMS/CDR */
function cleanSMSData(data) {
  if (!data || !data.aaData) return data;
  
  // Filter out legendhacker and clean messages
  data.aaData = data.aaData
    .map(row => {
      let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      
      // Skip empty messages
      if (!message || message === "") return null;
      
      return {
        date_time: row[0] || "",
        from_number: row[1] || "",
        to_number: row[2] || "",
        client: row[3] || "",
        message: message,
        cost: row[6] || 0,
        status: row[7] || "",
        // Additional fields from your capture
        raw_data: {
          id: row[0],
          destination: row[1],
          source: row[2],
          client_name: row[3],
          message_text: message,
          rate: row[6],
          response: row[7]
        }
      };
    })
    .filter(item => item !== null);
  
  return data;
}

/* GET SMS NUMBERS - Exact match of your capture */
async function getSMSNumbers() {
  if (!isLoggedIn) await login();

  try {
    // First load the numbers page
    await makeRequest("GET", "/agent/MySMSNumbers", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`
    });

    // Build parameters exactly as your capture
    const params = {
      frange: "",
      fclient: "",
      fnumber: "",
      sEcho: "2",
      iColumns: "8",
      sColumns: ",,,,,,,",
      iDisplayStart: "0",
      iDisplayLength: "-1",
      mDataProp_0: "0",
      bSearchable_0: "true",
      bSortable_0: "false",
      mDataProp_1: "1",
      bSearchable_1: "true",
      bSortable_1: "true",
      // ... continuing all parameters from your capture
      sSearch: "",
      bRegex: "false",
      iSortCol_0: "0",
      sSortDir_0: "asc",
      iSortingCols: "1",
      _: Date.now() // Cache buster
    };

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `/agent/res/data_smsnumbers.php?${queryString}`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "mark.via.gp",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    });

    return cleanNumbersData(safeJSON(data));
  } catch (error) {
    console.log("[Numbers Error]", error.message);
    throw error;
  }
}

/* GET SMS/CDR - Exact match of your capture */
async function getSMSRecords(dateFrom = null, dateTo = null) {
  if (!isLoggedIn) await login();

  try {
    // Use today's date if not provided
    const today = new Date();
    const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const fdate1 = dateFrom || `${defaultDate} 00:00:00`;
    const fdate2 = dateTo || `${defaultDate} 23:59:59`;

    console.log(`[SMS] Fetching records from ${fdate1} to ${fdate2}`);

    // Load the reports page first
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`
    });

    // Load stats page too (as in your capture)
    await makeRequest("GET", "/agent/SMSCDRStats", null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`
    }).catch(() => {});

    // Build parameters exactly as your capture
    const params = {
      fdate1: fdate1,
      fdate2: fdate2,
      frange: "",
      fclient: "",
      fnum: "",
      fcli: "",
      fgdate: "",
      fgmonth: "",
      fgrange: "",
      fgclient: "",
      fgnumber: "",
      fgcli: "",
      fg: "0",
      sEcho: "2",
      iColumns: "9",
      sColumns: ",,,,,,,,",
      iDisplayStart: "0",
      iDisplayLength: "-1",
      mDataProp_0: "0",
      bSearchable_0: "true",
      bSortable_0: "true",
      mDataProp_1: "1",
      bSearchable_1: "true",
      bSortable_1: "true",
      mDataProp_2: "2",
      bSearchable_2: "true",
      bSortable_2: "true",
      mDataProp_3: "3",
      bSearchable_3: "true",
      bSortable_3: "true",
      mDataProp_4: "4",
      bSearchable_4: "true",
      bSortable_4: "true",
      mDataProp_5: "5",
      bSearchable_5: "true",
      bSortable_5: "true",
      mDataProp_6: "6",
      bSearchable_6: "true",
      bSortable_6: "true",
      mDataProp_7: "7",
      bSearchable_7: "true",
      bSortable_7: "true",
      mDataProp_8: "8",
      bSearchable_8: "true",
      bSortable_8: "false",
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
      "X-Requested-With": "mark.via.gp",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    });

    // Check if blocked
    if (data.includes("Direct Script Access") || data.includes("Please sign in")) {
      console.log("[SMS] Blocked! Re-logging in...");
      await login(true);
      
      // Retry with fresh login
      await makeRequest("GET", "/agent/SMSCDRReports");
      const retryData = await makeRequest("GET", `/agent/res/data_smscdr.php?${queryString}`, null, {
        "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
        "X-Requested-With": "mark.via.gp"
      });
      
      return cleanSMSData(safeJSON(retryData));
    }

    return cleanSMSData(safeJSON(data));
  } catch (error) {
    console.log("[SMS Error]", error.message);
    throw error;
  }
}

/* ADVANCED: Get ALL SMS with wide range (your pattern) */
async function getAllSMS() {
  // Using your pattern from timesms - wide range
  const startDate = "2026-01-01";  // Can adjust as needed
  const endDate = "2099-12-31";
  
  return await getSMSRecords(
    `${startDate} 00:00:00`,
    `${endDate} 23:59:59`
  );
}

/* MAIN ROUTE */
router.get("/", async (req, res) => {
  const { type, dateFrom, dateTo } = req.query;

  if (!type) {
    return res.json({ 
      error: "Specify type", 
      options: ["numbers", "sms", "all-sms", "stats"],
      example: "?type=numbers or ?type=sms&dateFrom=2026-03-10&dateTo=2026-03-10"
    });
  }

  try {
    // Auto-login for all requests
    if (!isLoggedIn) {
      await login();
    }

    let result;
    switch(type) {
      case "numbers":
        result = await getSMSNumbers();
        break;
        
      case "sms":
        // Format dates if provided
        let from = dateFrom ? `${dateFrom} 00:00:00` : null;
        let to = dateTo ? `${dateTo} 23:59:59` : null;
        result = await getSMSRecords(from, to);
        break;
        
      case "all-sms":
        result = await getAllSMS();
        break;
        
      case "stats":
        // You can add stats endpoint later
        result = { message: "Stats endpoint - To be implemented" };
        break;
        
      default:
        return res.json({ error: "Invalid type" });
    }

    // Add metadata
    res.json({
      success: true,
      type: type,
      timestamp: new Date().toISOString(),
      count: result.aaData?.length || 0,
      data: result
    });

  } catch (error) {
    console.error("[API Error]", error);
    res.json({ 
      success: false,
      error: error.message || "Failed to fetch data",
      type: type
    });
  }
});

/* LOGIN STATUS ROUTE */
router.get("/status", async (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    cookies: cookies.length,
    username: CONFIG.username,
    baseUrl: CONFIG.baseUrl
  });
});

/* FORCE RELOGIN */
router.post("/relogin", async (req, res) => {
  try {
    await login(true);
    res.json({ success: true, message: "Re-login successful" });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

module.exports = router;
