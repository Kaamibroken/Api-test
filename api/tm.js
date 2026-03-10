const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

// ============ AUTO-CAPTURE CONFIG ============
const CONFIG = {
  baseUrl: "https://www.konektapremium.net",
  username: "kami526",
  password: "kami526",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

// ============ AUTO-CAPTURE STORAGE ============
let siteStructure = {
  // Login info
  login: {
    pageUrl: null,
    formAction: null,
    formMethod: null,
    usernameField: null,
    passwordField: null,
    captchaField: null,
    captchaType: null, // 'text', 'image', 'math', 'fixed'
    captchaValue: null,
    successIndicators: []
  },
  
  // Endpoints
  endpoints: {
    dashboard: null,
    numbers: {
      page: null,
      dataUrl: null,
      params: {}
    },
    sms: {
      page: null,
      dataUrl: null,
      params: {}
    },
    reports: null,
    stats: null
  },
  
  // Data formats
  dataFormat: {
    type: null, // 'datatable', 'json', 'html'
    dataKey: null,
    totalKey: null,
    columns: {}
  },
  
  // Session
  session: {
    cookies: [],
    phpsessid: null,
    lastActivity: null,
    isLoggedIn: false
  },
  
  // Debug
  debug: {
    lastScan: null,
    scanCount: 0,
    errors: []
  }
};

// ============ AUTO-CAPTURE FUNCTIONS ============

/* Smart Request with Auto-Retry */
async function autoRequest(method, path, data = null, options = {}) {
  const {
    isAjax = false,
    referer = null,
    retry = 3,
    timeout = 30000
  } = options;

  let lastError;
  
  for (let attempt = 1; attempt <= retry; attempt++) {
    try {
      const result = await makeRequest(method, path, data, {
        isAjax,
        referer,
        timeout
      });
      
      // Check if blocked
      if (result.includes("Direct Script Access") || 
          result.includes("Please sign in") ||
          result.includes("login")) {
        
        console.log(`[AUTO] Attempt ${attempt}: Blocked, retrying...`);
        
        if (attempt === retry - 1) {
          // Try to re-login
          await autoLogin(true);
        }
        
        continue;
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      console.log(`[AUTO] Attempt ${attempt} failed:`, error.message);
      
      if (attempt < retry) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  throw lastError || new Error("All retry attempts failed");
}

/* Make Request (Low Level) */
function makeRequest(method, path, data = null, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      isAjax = false,
      referer = null,
      timeout = 30000
    } = options;

    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;
    const urlObj = new URL(fullUrl);
    const httpModule = urlObj.protocol === 'https:' ? https : http;

    console.log(`[REQ] ${method} ${fullUrl}`);

    // Build headers dynamically
    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": isAjax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Cookie": siteStructure.session.cookies.join("; "),
      "Host": urlObj.hostname,
      "sec-ch-ua": '"Not:A-Brand";v="99", "Android WebView";v="145", "Chromium";v="145"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "Upgrade-Insecure-Requests": isAjax ? undefined : "1"
    };

    if (referer) {
      headers["Referer"] = referer.startsWith('http') ? referer : CONFIG.baseUrl + referer;
    }

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Origin"] = CONFIG.baseUrl;
      headers["X-Requested-With"] = "mark.via.gp";
    }

    if (isAjax) {
      headers["X-Requested-With"] = "mark.via.gp";
    }

    // Clean undefined headers
    Object.keys(headers).forEach(key => headers[key] === undefined && delete headers[key]);

    const options_ = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
      port: urlObj.protocol === 'https:' ? 443 : 80,
      rejectUnauthorized: false,
      timeout: timeout
    };

    const req = httpModule.request(options_, res => {
      // Store cookies
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const cookie = c.split(";")[0];
          if (!siteStructure.session.cookies.some(existing => existing.startsWith(cookie.split('=')[0]))) {
            siteStructure.session.cookies.push(cookie);
            
            // Extract PHPSESSID
            if (cookie.startsWith('PHPSESSID=')) {
              siteStructure.session.phpsessid = cookie.split('=')[1];
              siteStructure.session.lastActivity = Date.now();
            }
          }
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (data) req.write(data);
    req.end();
  });
}

/* AUTO-CAPTURE SITE STRUCTURE */
async function autoCaptureSite() {
  console.log("\n🔍 ===== AUTO-CAPTURE START =====\n");
  
  siteStructure.debug.lastScan = new Date().toISOString();
  siteStructure.debug.scanCount++;

  try {
    // STEP 1: Capture Main Page
    console.log("📌 Step 1: Capturing main page...");
    const mainPage = await makeRequest("GET", "/", null, { timeout: 10000 });
    
    // STEP 2: Capture Login Page
    console.log("📌 Step 2: Capturing login page...");
    const loginPage = await autoCaptureLogin();
    
    // STEP 3: Try Login
    console.log("📌 Step 3: Attempting login...");
    const loginSuccess = await autoLogin();
    
    if (loginSuccess) {
      // STEP 4: Capture Dashboard
      console.log("📌 Step 4: Capturing dashboard...");
      await autoCaptureDashboard();
      
      // STEP 5: Capture Endpoints
      console.log("📌 Step 5: Capturing data endpoints...");
      await autoCaptureEndpoints();
      
      // STEP 6: Capture Data Format
      console.log("📌 Step 6: Capturing data format...");
      await autoCaptureDataFormat();
    }
    
    console.log("\n✅ ===== AUTO-CAPTURE COMPLETE =====\n");
    console.log("Site Structure:", JSON.stringify(siteStructure, null, 2));
    
    return siteStructure;
    
  } catch (error) {
    console.log("\n❌ Auto-capture error:", error.message);
    siteStructure.debug.errors.push({
      time: new Date().toISOString(),
      error: error.message
    });
    return siteStructure;
  }
}

/* AUTO-CAPTURE LOGIN */
async function autoCaptureLogin() {
  console.log("   [Login Detection]");
  
  const loginPage = await makeRequest("GET", "/sign-in", null, { timeout: 10000 });
  
  // Detect form action
  const formMatch = loginPage.match(/<form[^>]*action=["']([^"']*)["']/i);
  siteStructure.login.formAction = formMatch ? formMatch[1] : "/signin";
  console.log(`   - Form action: ${siteStructure.login.formAction}`);
  
  // Detect form method
  const methodMatch = loginPage.match(/<form[^>]*method=["']([^"']*)["']/i);
  siteStructure.login.formMethod = methodMatch ? methodMatch[1].toUpperCase() : "POST";
  console.log(`   - Form method: ${siteStructure.login.formMethod}`);
  
  // Detect username field
  const usernamePatterns = ['name=["\']([^"\']*user[^"\']*)["\']', 'name=["\']([^"\']*login[^"\']*)["\']', 'name=["\']([^"\']*email[^"\']*)["\']'];
  for (const pattern of usernamePatterns) {
    const match = loginPage.match(new RegExp(pattern, 'i'));
    if (match) {
      siteStructure.login.usernameField = match[1];
      break;
    }
  }
  siteStructure.login.usernameField = siteStructure.login.usernameField || "username";
  console.log(`   - Username field: ${siteStructure.login.usernameField}`);
  
  // Detect password field
  const passwordPatterns = ['name=["\']([^"\']*pass[^"\']*)["\']', 'name=["\']([^"\']*pwd[^"\']*)["\']'];
  for (const pattern of passwordPatterns) {
    const match = loginPage.match(new RegExp(pattern, 'i'));
    if (match) {
      siteStructure.login.passwordField = match[1];
      break;
    }
  }
  siteStructure.login.passwordField = siteStructure.login.passwordField || "password";
  console.log(`   - Password field: ${siteStructure.login.passwordField}`);
  
  // Detect CAPTCHA
  await autoDetectCaptcha(loginPage);
  
  // Detect success indicators
  const indicators = ['dashboard', 'SMSDashboard', 'MySMSNumbers', 'Welcome', 'logout'];
  siteStructure.login.successIndicators = indicators;
  
  return loginPage;
}

/* AUTO-DETECT CAPTCHA */
async function autoDetectCaptcha(page) {
  console.log("   [CAPTCHA Detection]");
  
  // Check for math CAPTCHA
  const mathMatch = page.match(/What is (\d+)\s*\+\s*(\d+)/i) || 
                    page.match(/(\d+)\s*\+\s*(\d+)\s*=/i);
  
  if (mathMatch && mathMatch[1] && mathMatch[2]) {
    siteStructure.login.captchaType = 'math';
    siteStructure.login.captchaValue = Number(mathMatch[1]) + Number(mathMatch[2]);
    console.log(`   - Type: Math (${mathMatch[1]} + ${mathMatch[2]} = ${siteStructure.login.captchaValue})`);
  }
  
  // Check for fixed value
  const fixedMatch = page.match(/name=["']capt["'].*?value=["'](\d+)["']/i);
  if (fixedMatch) {
    siteStructure.login.captchaType = 'fixed';
    siteStructure.login.captchaValue = fixedMatch[1];
    console.log(`   - Type: Fixed (${siteStructure.login.captchaValue})`);
  }
  
  // Check for image CAPTCHA
  if (page.includes('captcha') && page.includes('.jpg') || page.includes('.png')) {
    siteStructure.login.captchaType = 'image';
    console.log(`   - Type: Image CAPTCHA (requires manual)`);
  }
  
  // Detect CAPTCHA field name
  const captchaFieldMatch = page.match(/name=["']([^"']*capt[^"']*)["']/i);
  siteStructure.login.captchaField = captchaFieldMatch ? captchaFieldMatch[1] : "capt";
  console.log(`   - Field name: ${siteStructure.login.captchaField}`);
  
  if (!siteStructure.login.captchaType) {
    siteStructure.login.captchaType = 'unknown';
    siteStructure.login.captchaValue = 4; // Default from your capture
    console.log(`   - Type: Unknown, using default (4)`);
  }
}

/* AUTO-LOGIN */
async function autoLogin(force = false) {
  if (siteStructure.session.isLoggedIn && !force) return true;
  
  console.log("   [Login Attempt]");
  
  siteStructure.session.cookies = [];
  siteStructure.session.isLoggedIn = false;

  try {
    // Get fresh login page if needed
    if (!siteStructure.login.formAction || force) {
      await autoCaptureLogin();
    }
    
    // Prepare login data
    const formData = {};
    formData[siteStructure.login.usernameField] = CONFIG.username;
    formData[siteStructure.login.passwordField] = CONFIG.password;
    
    // Handle CAPTCHA
    if (siteStructure.login.captchaType === 'math') {
      // Re-calculate math CAPTCHA
      const loginPage = await makeRequest("GET", "/sign-in");
      const mathMatch = loginPage.match(/What is (\d+)\s*\+\s*(\d+)/i);
      if (mathMatch) {
        formData[siteStructure.login.captchaField] = Number(mathMatch[1]) + Number(mathMatch[2]);
        console.log(`   - Math CAPTCHA: ${mathMatch[1]} + ${mathMatch[2]} = ${formData[siteStructure.login.captchaField]}`);
      } else {
        formData[siteStructure.login.captchaField] = siteStructure.login.captchaValue || 4;
      }
    } else {
      formData[siteStructure.login.captchaField] = siteStructure.login.captchaValue || 4;
    }
    
    console.log("   - Form data:", formData);
    
    // Submit login
    const formEncoded = querystring.stringify(formData);
    
    const loginResult = await makeRequest(
      siteStructure.login.formMethod || "POST",
      siteStructure.login.formAction,
      formEncoded,
      {
        referer: "/sign-in",
        timeout: 15000
      }
    );
    
    // Verify login
    const agentPage = await makeRequest("GET", "/agent/", null, {
      referer: "/sign-in",
      timeout: 10000
    });
    
    // Check success
    for (const indicator of siteStructure.login.successIndicators) {
      if (agentPage.includes(indicator)) {
        siteStructure.session.isLoggedIn = true;
        console.log(`   ✅ Login successful! (${indicator})`);
        
        // Load dashboard
        await makeRequest("GET", "/agent/SMSDashboard", null, {
          referer: "/agent/"
        }).catch(() => {});
        
        return true;
      }
    }
    
    console.log("   ❌ Login failed - checking error messages...");
    
    // Check for error messages
    const errorMatch = agentPage.match(/>(Invalid|Wrong|Incorrect|Error).*?</i);
    if (errorMatch) {
      throw new Error(`Login failed: ${errorMatch[1]}`);
    }
    
    throw new Error("Login failed - Unknown reason");
    
  } catch (error) {
    console.log("   ❌ Login error:", error.message);
    throw error;
  }
}

/* AUTO-CAPTURE DASHBOARD */
async function autoCaptureDashboard() {
  console.log("   [Dashboard Detection]");
  
  // Try different dashboard paths
  const dashboardPaths = ['/agent/', '/dashboard', '/agent/SMSDashboard'];
  
  for (const path of dashboardPaths) {
    try {
      const page = await makeRequest("GET", path, null, {
        referer: "/sign-in",
        timeout: 10000
      });
      
      if (page.includes('SMSDashboard') || page.includes('MySMSNumbers')) {
        siteStructure.endpoints.dashboard = path;
        console.log(`   - Dashboard found: ${path}`);
        break;
      }
    } catch (e) {}
  }
}

/* AUTO-CAPTURE ENDPOINTS */
async function autoCaptureEndpoints() {
  console.log("   [Endpoint Detection]");
  
  // Common endpoint patterns
  const numberPatterns = [
    '/agent/res/data_smsnumbers.php',
    '/agent/api/numbers',
    '/sms-numbers',
    '/api/sms-numbers'
  ];
  
  const smsPatterns = [
    '/agent/res/data_smscdr.php',
    '/agent/api/sms',
    '/sms-records',
    '/api/sms-cdr'
  ];
  
  const reportPatterns = [
    '/agent/SMSCDRReports',
    '/reports',
    '/sms-reports'
  ];
  
  const statsPatterns = [
    '/agent/SMSCDRStats',
    '/stats',
    '/sms-stats'
  ];
  
  // Try to detect numbers endpoint
  for (const pattern of numberPatterns) {
    try {
      const test = await autoRequest("GET", pattern + "?sEcho=1", null, {
        isAjax: true,
        retry: 1
      });
      
      if (test && (test.includes('aaData') || test.includes('{'))) {
        siteStructure.endpoints.numbers.dataUrl = pattern;
        console.log(`   - Numbers endpoint: ${pattern}`);
        break;
      }
    } catch (e) {}
  }
  
  // Try to detect SMS endpoint
  for (const pattern of smsPatterns) {
    try {
      const test = await autoRequest("GET", pattern + "?sEcho=1", null, {
        isAjax: true,
        retry: 1
      });
      
      if (test && (test.includes('aaData') || test.includes('{'))) {
        siteStructure.endpoints.sms.dataUrl = pattern;
        console.log(`   - SMS endpoint: ${pattern}`);
        break;
      }
    } catch (e) {}
  }
  
  // Try to detect reports page
  for (const pattern of reportPatterns) {
    try {
      const page = await makeRequest("GET", pattern, null, {
        referer: "/agent/"
      });
      
      if (page && page.length > 100) {
        siteStructure.endpoints.reports = pattern;
        console.log(`   - Reports page: ${pattern}`);
        break;
      }
    } catch (e) {}
  }
  
  // Try to detect stats page
  for (const pattern of statsPatterns) {
    try {
      const page = await makeRequest("GET", pattern, null, {
        referer: "/agent/"
      });
      
      if (page && page.length > 100) {
        siteStructure.endpoints.stats = pattern;
        console.log(`   - Stats page: ${pattern}`);
        break;
      }
    } catch (e) {}
  }
}

/* AUTO-CAPTURE DATA FORMAT */
async function autoCaptureDataFormat() {
  console.log("   [Data Format Detection]");
  
  if (!siteStructure.endpoints.numbers.dataUrl) return;
  
  try {
    const testData = await autoRequest("GET", siteStructure.endpoints.numbers.dataUrl + "?sEcho=1", null, {
      isAjax: true
    });
    
    const json = safeJSON(testData);
    
    // Detect data key
    const possibleKeys = ['aaData', 'data', 'rows', 'records', 'result'];
    for (const key of possibleKeys) {
      if (json[key] !== undefined) {
        siteStructure.dataFormat.dataKey = key;
        console.log(`   - Data key: ${key}`);
        break;
      }
    }
    
    // Detect total key
    const totalKeys = ['iTotalRecords', 'total', 'recordsTotal', 'count'];
    for (const key of totalKeys) {
      if (json[key] !== undefined) {
        siteStructure.dataFormat.totalKey = key;
        console.log(`   - Total key: ${key}`);
        break;
      }
    }
    
    // Detect column structure
    if (json[siteStructure.dataFormat.dataKey] && json[siteStructure.dataFormat.dataKey][0]) {
      const firstRow = json[siteStructure.dataFormat.dataKey][0];
      if (Array.isArray(firstRow)) {
        siteStructure.dataFormat.columns.count = firstRow.length;
        siteStructure.dataFormat.columns.type = 'array';
        console.log(`   - Columns: ${firstRow.length} (array)`);
      } else if (typeof firstRow === 'object') {
        siteStructure.dataFormat.columns.count = Object.keys(firstRow).length;
        siteStructure.dataFormat.columns.type = 'object';
        siteStructure.dataFormat.columns.names = Object.keys(firstRow);
        console.log(`   - Columns: ${Object.keys(firstRow).length} (object)`);
      }
    }
    
  } catch (error) {
    console.log("   - Data format detection failed:", error.message);
  }
}

/* ============ DATA CLEANING FUNCTIONS ============ */

function cleanNumbersData(data) {
  if (!data || !data[siteStructure.dataFormat.dataKey || 'aaData']) return data;
  
  const rawData = data[siteStructure.dataFormat.dataKey || 'aaData'];
  
  if (Array.isArray(rawData)) {
    const cleaned = rawData.map(row => {
      if (Array.isArray(row)) {
        return [
          row[1] || "",        // Number
          "",                  // Empty
          row[2] || "",        // Client
          "Weekly",            // Type
          (row[4] || "").replace(/<[^>]+>/g, "").trim(),  // Status
          (row[5] || "").replace(/<[^>]+>/g, "").trim()   // Expiry
        ];
      }
      return row;
    });
    
    data[siteStructure.dataFormat.dataKey || 'aaData'] = cleaned;
  }
  
  return data;
}

function cleanSMSData(data) {
  if (!data || !data[siteStructure.dataFormat.dataKey || 'aaData']) return data;
  
  const rawData = data[siteStructure.dataFormat.dataKey || 'aaData'];
  
  if (Array.isArray(rawData)) {
    const cleaned = rawData
      .map(row => {
        if (Array.isArray(row)) {
          let message = (row[5] || "").replace(/legendhacker/gi, "").trim();
          if (!message) return null;
          
          return [
            row[0] || "",     // Date
            row[1] || "",     // From
            row[2] || "",     // To
            row[3] || "",     // Client
            message,          // Message
            "$",              // Currency
            (row[7] || "").replace(/<[^>]+>/g, "").trim() // Status
          ];
        }
        return row;
      })
      .filter(Boolean);
    
    data[siteStructure.dataFormat.dataKey || 'aaData'] = cleaned;
  }
  
  return data;
}

/* ============ API FUNCTIONS ============ */

async function getNumbers() {
  if (!siteStructure.session.isLoggedIn) {
    await autoLogin();
  }

  try {
    // Load numbers page
    const numbersPage = siteStructure.endpoints.numbers.page || "/agent/MySMSNumbers";
    await makeRequest("GET", numbersPage, null, {
      referer: "/agent/"
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Fetch data
    const params = {
      frange: "",
      fclient: "",
      fnumber: "",
      sEcho: "2",
      iDisplayStart: "0",
      iDisplayLength: "-1",
      _: Date.now()
    };

    const queryString = querystring.stringify(params);
    const endpoint = siteStructure.endpoints.numbers.dataUrl || "/agent/res/data_smsnumbers.php";
    
    const data = await autoRequest("GET", `${endpoint}?${queryString}`, null, {
      isAjax: true,
      referer: numbersPage,
      retry: 3
    });

    const json = safeJSON(data);
    return cleanNumbersData(json);
    
  } catch (error) {
    console.log("[Numbers Error]", error.message);
    throw error;
  }
}

async function getSMS(dateFrom = null, dateTo = null) {
  if (!siteStructure.session.isLoggedIn) {
    await autoLogin();
  }

  try {
    // Load reports page
    const reportsPage = siteStructure.endpoints.reports || "/agent/SMSCDRReports";
    await makeRequest("GET", reportsPage, null, {
      referer: "/agent/"
    });

    // Load stats page if available
    if (siteStructure.endpoints.stats) {
      await makeRequest("GET", siteStructure.endpoints.stats, null, {
        referer: reportsPage
      }).catch(() => {});
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Date range
    const startDate = dateFrom || "2026-01-01 00:00:00";
    const endDate = dateTo || "2099-12-31 23:59:59";

    const params = {
      fdate1: startDate,
      fdate2: endDate,
      frange: "",
      fclient: "",
      fnum: "",
      fcli: "",
      fg: "0",
      sEcho: "2",
      iDisplayStart: "0",
      iDisplayLength: "2000",
      iSortCol_0: "0",
      sSortDir_0: "desc",
      _: Date.now()
    };

    const queryString = querystring.stringify(params);
    const endpoint = siteStructure.endpoints.sms.dataUrl || "/agent/res/data_smscdr.php";
    
    const data = await autoRequest("GET", `${endpoint}?${queryString}`, null, {
      isAjax: true,
      referer: reportsPage,
      retry: 3
    });

    const json = safeJSON(data);
    return cleanSMSData(json);
    
  } catch (error) {
    console.log("[SMS Error]", error.message);
    throw error;
  }
}

/* ============ EXPRESS ROUTES ============ */

/* Auto-capture endpoint */
router.get("/capture", async (req, res) => {
  try {
    const structure = await autoCaptureSite();
    res.json({
      success: true,
      message: "Site structure captured",
      structure: structure
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

/* Main API */
router.get("/", async (req, res) => {
  const { type, dateFrom, dateTo } = req.query;

  if (!type) {
    return res.json({
      error: "Specify type",
      options: ["numbers", "sms", "capture", "status"],
      note: "First run ?type=capture to auto-detect site structure"
    });
  }

  try {
    // Auto-capture if not done yet
    if (!siteStructure.debug.lastScan && type !== "capture") {
      await autoCaptureSite();
    }

    let result;
    
    switch(type) {
      case "capture":
        result = await autoCaptureSite();
        break;
        
      case "numbers":
        result = await getNumbers();
        break;
        
      case "sms":
        if (dateFrom && dateTo) {
          result = await getSMS(
            `${dateFrom} 00:00:00`,
            `${dateTo} 23:59:59`
          );
        } else {
          result = await getSMS();
        }
        break;
        
      case "status":
        return res.json({
          success: true,
          structure: siteStructure,
          session: {
            loggedIn: siteStructure.session.isLoggedIn,
            cookies: siteStructure.session.cookies.length,
            phpsessid: siteStructure.session.phpsessid
          }
        });
        
      default:
        return res.json({ error: "Invalid type" });
    }

    res.json({
      success: true,
      type: type,
      count: result[siteStructure.dataFormat.dataKey || 'aaData']?.length || 0,
      structure: siteStructure.debug.lastScan ? {
        lastScan: siteStructure.debug.lastScan,
        endpoints: {
          numbers: siteStructure.endpoints.numbers.dataUrl,
          sms: siteStructure.endpoints.sms.dataUrl
        }
      } : null,
      data: result
    });

  } catch (error) {
    console.error("[API Error]", error);
    res.json({
      success: false,
      error: error.message,
      type: type,
      suggestion: "Try running ?type=capture first to re-detect site structure"
    });
  }
});

/* Force re-login */
router.post("/relogin", async (req, res) => {
  try {
    await autoLogin(true);
    res.json({
      success: true,
      message: "Re-login successful",
      session: {
        loggedIn: siteStructure.session.isLoggedIn,
        phpsessid: siteStructure.session.phpsessid
      }
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
