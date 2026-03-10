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
let lastCaptchaValue = 4;

// ============ AUTO-CORRECT CAPTURE SYSTEM ============
const sitePatterns = {
  // Login page patterns
  login: {
    formAction: ['/signin', '/login', '/auth', '/sign-in'],
    usernameField: ['username', 'user', 'email', 'login'],
    passwordField: ['password', 'pass', 'pwd'],
    captchaField: ['capt', 'captcha', 'code', 'verification'],
    successIndicator: ['/agent/', 'dashboard', 'SMSDashboard', 'MySMSNumbers']
  },
  
  // Endpoint patterns
  endpoints: {
    numbers: ['/agent/res/data_smsnumbers.php', '/agent/api/numbers', '/sms-numbers'],
    sms: ['/agent/res/data_smscdr.php', '/agent/api/sms', '/sms-records'],
    dashboard: ['/agent/SMSDashboard', '/agent/', '/dashboard'],
    reports: ['/agent/SMSCDRReports', '/reports', '/sms-reports']
  },
  
  // Response patterns
  responseFormats: {
    datatable: ['aaData', 'data', 'records', 'rows'],
    total: ['iTotalRecords', 'total', 'count', 'recordsTotal']
  }
};

// Capture latest structure
let capturedStructure = {
  loginAction: '/signin',
  captchaField: 'capt',
  numbersEndpoint: '/agent/res/data_smsnumbers.php',
  smsEndpoint: '/agent/res/data_smscdr.php',
  dataTableFormat: {
    dataKey: 'aaData',
    totalKey: 'iTotalRecords',
    displayKey: 'iTotalDisplayRecords'
  },
  numberColumns: 8,
  smsColumns: 9,
  lastUpdated: null
};

/* AUTO-DETECT FUNCTION */
async function detectSiteStructure() {
  console.log("[AUTO-CAPTURE] Detecting site structure...");
  
  try {
    // Try to access main page
    const mainPage = await makeRequest("GET", "/", null, {
      "Accept": "text/html"
    }).catch(() => "");
    
    // Detect login form action
    const formMatch = mainPage.match(/<form[^>]*action=["']([^"']*)["']/i) ||
                     mainPage.match(/action=["']([^"']*sign[^"']*)["']/i);
    if (formMatch && formMatch[1]) {
      capturedStructure.loginAction = formMatch[1].startsWith('/') ? formMatch[1] : '/' + formMatch[1];
      console.log(`[AUTO-CAPTURE] Found login action: ${capturedStructure.loginAction}`);
    }
    
    // Detect CAPTCHA field
    const captchaMatch = mainPage.match(/name=["']([^"']*capt[^"']*)["']/i) ||
                        mainPage.match(/id=["']([^"']*capt[^"']*)["']/i);
    if (captchaMatch && captchaMatch[1]) {
      capturedStructure.captchaField = captchaMatch[1];
      console.log(`[AUTO-CAPTURE] Found CAPTCHA field: ${capturedStructure.captchaField}`);
    }
    
    // After login, try to detect endpoints
    if (isLoggedIn) {
      await detectDataEndpoints();
    }
    
    capturedStructure.lastUpdated = new Date().toISOString();
    return capturedStructure;
    
  } catch (error) {
    console.log("[AUTO-CAPTURE] Detection error:", error.message);
    return capturedStructure;
  }
}

/* DETECT DATA ENDPOINTS */
async function detectDataEndpoints() {
  try {
    // Try common patterns for numbers endpoint
    for (const endpoint of sitePatterns.endpoints.numbers) {
      const test = await makeRequest("GET", endpoint + "?sEcho=1", null, {
        "X-Requested-With": "XMLHttpRequest"
      }).catch(() => null);
      
      if (test && (test.includes('aaData') || test.includes('{'))) {
        capturedStructure.numbersEndpoint = endpoint;
        console.log(`[AUTO-CAPTURE] Numbers endpoint: ${endpoint}`);
        
        // Detect column count
        try {
          const json = JSON.parse(test);
          if (json.aaData && json.aaData[0]) {
            capturedStructure.numberColumns = json.aaData[0].length;
            console.log(`[AUTO-CAPTURE] Number columns: ${capturedStructure.numberColumns}`);
          }
        } catch (e) {}
        break;
      }
    }
    
    // Try common patterns for SMS endpoint
    for (const endpoint of sitePatterns.endpoints.sms) {
      const test = await makeRequest("GET", endpoint + "?sEcho=1", null, {
        "X-Requested-With": "XMLHttpRequest"
      }).catch(() => null);
      
      if (test && (test.includes('aaData') || test.includes('{'))) {
        capturedStructure.smsEndpoint = endpoint;
        console.log(`[AUTO-CAPTURE] SMS endpoint: ${endpoint}`);
        
        // Detect column count
        try {
          const json = JSON.parse(test);
          if (json.aaData && json.aaData[0]) {
            capturedStructure.smsColumns = json.aaData[0].length;
            console.log(`[AUTO-CAPTURE] SMS columns: ${capturedStructure.smsColumns}`);
          }
        } catch (e) {}
        break;
      }
    }
    
    // Detect data format
    if (capturedStructure.numbersEndpoint) {
      const test = await makeRequest("GET", capturedStructure.numbersEndpoint + "?sEcho=1", null, {
        "X-Requested-With": "XMLHttpRequest"
      }).catch(() => null);
      
      if (test) {
        try {
          const json = JSON.parse(test);
          // Find which key contains the data
          for (const key of sitePatterns.responseFormats.datatable) {
            if (json[key]) {
              capturedStructure.dataTableFormat.dataKey = key;
              break;
            }
          }
          // Find total key
          for (const key of sitePatterns.responseFormats.total) {
            if (json[key] !== undefined) {
              capturedStructure.dataTableFormat.totalKey = key;
              break;
            }
          }
          console.log(`[AUTO-CAPTURE] Data format: ${JSON.stringify(capturedStructure.dataTableFormat)}`);
        } catch (e) {}
      }
    }
    
  } catch (error) {
    console.log("[AUTO-CAPTURE] Endpoint detection error:", error.message);
  }
}

// ============ HELPER FUNCTIONS ============

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

/* DYNAMIC PARAM BUILDER */
function buildDataTableParams(type, customParams = {}) {
  const baseParams = {
    sEcho: customParams.sEcho || "2",
    iDisplayStart: customParams.start || "0",
    iDisplayLength: customParams.length || "-1",
    sSearch: customParams.search || "",
    bRegex: "false",
    iSortCol_0: customParams.sortCol || "0",
    sSortDir_0: customParams.sortDir || "desc",
    iSortingCols: "1",
    _: Date.now()
  };
  
  // Add column definitions based on detected structure
  const columnCount = type === 'numbers' ? capturedStructure.numberColumns : capturedStructure.smsColumns;
  
  for (let i = 0; i < columnCount; i++) {
    baseParams[`mDataProp_${i}`] = i.toString();
    baseParams[`bSearchable_${i}`] = "true";
    baseParams[`bSortable_${i}`] = i < columnCount - 1 ? "true" : "false";
  }
  
  baseParams.iColumns = columnCount.toString();
  baseParams.sColumns = Array(columnCount).fill('').join(',');
  
  return { ...baseParams, ...customParams };
}

// ============ REQUEST FUNCTION ============

function makeRequest(method, path, data = null, extraHeaders = {}, retryCount = 0) {
  return new Promise((resolve, reject) => {
    let cleanPath = path.startsWith('/') ? path : '/' + path;
    const fullUrl = CONFIG.baseUrl + cleanPath;
    const urlObj = new URL(fullUrl);
    const httpModule = urlObj.protocol === 'https:' ? https : http;

    console.log(`[REQ] ${method} ${fullUrl}`);

    const headers = {
      "User-Agent": CONFIG.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-PK,en;q=0.9",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Cookie": cookies.join("; "),
      "Upgrade-Insecure-Requests": "1",
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
      rejectUnauthorized: false,
      timeout: 30000
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
        
        // Handle compression
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") {
          try { buffer = zlib.gunzipSync(buffer); } catch (e) { }
        } else if (encoding === "deflate") {
          try { buffer = zlib.inflateSync(buffer); } catch (e) { }
        } else if (encoding === "br") {
          try { 
            if (zlib.brotliDecompressSync) {
              buffer = zlib.brotliDecompressSync(buffer); 
            }
          } catch (e) { }
        }
        
        const responseText = buffer.toString();
        
        // Auto-correct on access denied
        if (responseText.includes("Direct Script Access") || 
            responseText.includes("Please sign in") ||
            responseText.includes("login") && retryCount < 2) {
          console.log("[AUTO-CORRECT] Access denied, re-logging...");
          login(true).then(() => {
            // Retry the request with fresh login
            makeRequest(method, path, data, extraHeaders, retryCount + 1)
              .then(resolve)
              .catch(reject);
          }).catch(reject);
          return;
        }
        
        resolve(responseText);
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

// ============ LOGIN WITH AUTO-CAPTURE ============

async function login(force = false) {
  if (isLoggedIn && !force) return true;
  
  cookies = [];
  isLoggedIn = false;

  try {
    console.log("[LOGIN] Starting login process...");
    
    // Auto-detect structure on first login
    if (!capturedStructure.lastUpdated) {
      await detectSiteStructure();
    }
    
    // Get login page
    const loginPage = await makeRequest("GET", "/sign-in", null, {
      "Accept": "text/html"
    });
    
    // Auto-detect CAPTCHA if not found
    let captchaValue = lastCaptchaValue;
    if (capturedStructure.captchaField === 'capt') {
      // Try to extract from page
      const captchaMatch = loginPage.match(/What is (\d+)\s*\+\s*(\d+)/i) ||
                          loginPage.match(/captcha.*?(\d+).*?(\d+)/i) ||
                          loginPage.match(new RegExp(capturedStructure.captchaField + '.*?value="?(\\d+)"?', 'i'));
      
      if (captchaMatch) {
        if (captchaMatch[1] && captchaMatch[2]) {
          captchaValue = Number(captchaMatch[1]) + Number(captchaMatch[2]);
        } else if (captchaMatch[1]) {
          captchaValue = captchaMatch[1];
        }
      }
    }
    
    console.log(`[LOGIN] Using CAPTCHA: ${captchaValue}`);
    
    // Build form data with auto-detected field names
    const formData = {};
    formData[capturedStructure.captchaField] = captchaValue;
    
    // Try common username/password field names
    let usernameField = 'username';
    let passwordField = 'password';
    
    // Detect from page
    const usernameMatch = loginPage.match(/name=["']([^"']*user[^"']*)["']/i);
    if (usernameMatch) usernameField = usernameMatch[1];
    
    const passwordMatch = loginPage.match(/name=["']([^"']*pass[^"']*)["']/i);
    if (passwordMatch) passwordField = passwordMatch[1];
    
    formData[usernameField] = CONFIG.username;
    formData[passwordField] = CONFIG.password;
    
    const formEncoded = querystring.stringify(formData);

    // Submit login
    const loginResult = await makeRequest("POST", capturedStructure.loginAction, formEncoded, {
      "Referer": `${CONFIG.baseUrl}/sign-in`,
      "X-Requested-With": "mark.via.gp"
    });

    // Verify login
    const agentPage = await makeRequest("GET", "/agent/", null, {
      "Referer": `${CONFIG.baseUrl}/sign-in`
    });

    // Check success indicators
    let loginSuccess = false;
    for (const indicator of sitePatterns.login.successIndicator) {
      if (agentPage.includes(indicator)) {
        loginSuccess = true;
        break;
      }
    }

    if (loginSuccess) {
      isLoggedIn = true;
      lastCaptchaValue = captchaValue;
      console.log("[LOGIN] Success!");
      
      // Auto-detect endpoints after login
      await detectDataEndpoints();
      
      return true;
    } else {
      throw new Error("Login failed");
    }
  } catch (error) {
    console.log("[LOGIN] Error:", error.message);
    isLoggedIn = false;
    throw error;
  }
}

// ============ DATA CLEANING FUNCTIONS ============

function cleanNumbersData(data) {
  if (!data || !data[capturedStructure.dataTableFormat.dataKey]) return data;
  
  const rawData = data[capturedStructure.dataTableFormat.dataKey];
  const cleaned = [];
  
  for (const row of rawData) {
    const cleanedRow = {};
    
    // Try to intelligently map fields
    if (Array.isArray(row)) {
      cleanedRow.id = row[0] || "";
      cleanedRow.number = row[1] || "";
      cleanedRow.client = row[2] || "";
      cleanedRow.type = row[3] || "";
      cleanedRow.status = (row[4] || "").replace(/<[^>]+>/g, "").trim();
      cleanedRow.expiry = (row[5] || "").replace(/<[^>]+>/g, "").trim();
      cleanedRow.sms_count = row[6] || 0;
      cleanedRow.actions = (row[7] || "").replace(/<[^>]+>/g, "").trim();
    } else if (typeof row === 'object') {
      // If it's already an object, just clean HTML
      Object.keys(row).forEach(key => {
        if (typeof row[key] === 'string') {
          cleanedRow[key] = row[key].replace(/<[^>]+>/g, "").trim();
        } else {
          cleanedRow[key] = row[key];
        }
      });
    }
    
    cleaned.push(cleanedRow);
  }
  
  data[capturedStructure.dataTableFormat.dataKey] = cleaned;
  return data;
}

function cleanSMSData(data) {
  if (!data || !data[capturedStructure.dataTableFormat.dataKey]) return data;
  
  const rawData = data[capturedStructure.dataTableFormat.dataKey];
  const cleaned = [];
  
  for (const row of rawData) {
    let message = "";
    let cleanedRow = {};
    
    if (Array.isArray(row)) {
      message = (row[5] || "").replace(/legendhacker/gi, "").trim();
      
      // Skip empty messages
      if (!message) continue;
      
      cleanedRow = {
        date_time: row[0] || "",
        from_number: row[1] || "",
        to_number: row[2] || "",
        client: row[3] || "",
        message: message,
        cost: row[6] || 0,
        status: (row[7] || "").replace(/<[^>]+>/g, "").trim()
      };
    } else if (typeof row === 'object') {
      // Find message field
      const messageKey = Object.keys(row).find(k => 
        String(row[k]).toLowerCase().includes('legendhacker') || 
        (typeof row[k] === 'string' && row[k].length > 20)
      );
      
      if (messageKey) {
        message = String(row[messageKey]).replace(/legendhacker/gi, "").trim();
        if (!message) continue;
      }
      
      // Clean all fields
      Object.keys(row).forEach(key => {
        if (typeof row[key] === 'string') {
          cleanedRow[key] = row[key].replace(/<[^>]+>/g, "").trim();
        } else {
          cleanedRow[key] = row[key];
        }
      });
    }
    
    cleaned.push(cleanedRow);
  }
  
  data[capturedStructure.dataTableFormat.dataKey] = cleaned;
  return data;
}

// ============ MAIN API FUNCTIONS ============

async function getSMSNumbers() {
  if (!isLoggedIn) await login();

  try {
    // Load numbers page
    await makeRequest("GET", "/agent/MySMSNumbers", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`
    });

    // Build params using auto-detected structure
    const params = buildDataTableParams('numbers', {
      frange: "",
      fclient: "",
      fnumber: ""
    });

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `${capturedStructure.numbersEndpoint}?${queryString}`, null, {
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

async function getSMSRecords(dateFrom = null, dateTo = null, filters = {}) {
  if (!isLoggedIn) await login();

  try {
    // Default to today
    const today = new Date();
    const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const fdate1 = dateFrom || `${defaultDate} 00:00:00`;
    const fdate2 = dateTo || `${defaultDate} 23:59:59`;

    console.log(`[SMS] Fetching from ${fdate1} to ${fdate2}`);

    // Load reports page
    await makeRequest("GET", "/agent/SMSCDRReports", null, {
      "Referer": `${CONFIG.baseUrl}/agent/`
    });

    // Build params with filters
    const params = buildDataTableParams('sms', {
      fdate1: fdate1,
      fdate2: fdate2,
      frange: filters.range || "",
      fclient: filters.client || "",
      fnum: filters.number || "",
      fcli: filters.cli || "",
      fg: "0",
      ...filters
    });

    const queryString = querystring.stringify(params);
    
    const data = await makeRequest("GET", `${capturedStructure.smsEndpoint}?${queryString}`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "mark.via.gp",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    });

    return cleanSMSData(safeJSON(data));
  } catch (error) {
    console.log("[SMS Error]", error.message);
    throw error;
  }
}

// ============ EXPRESS ROUTES ============

/* Main API endpoint */
router.get("/", async (req, res) => {
  const { 
    type, 
    dateFrom, 
    dateTo,
    client,
    number,
    cli,
    start,
    length 
  } = req.query;

  if (!type) {
    return res.json({ 
      success: false,
      error: "Specify type",
      available: ["numbers", "sms", "reports", "stats", "structure"],
      example: "?type=numbers",
      auto_captured: capturedStructure,
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (!isLoggedIn) {
      await login();
    }

    let result;
    let metadata = {
      type: type,
      captured_structure: capturedStructure,
      auto_corrected: true
    };

    switch(type) {
      case "numbers":
        result = await getSMSNumbers();
        metadata.count = result[capturedStructure.dataTableFormat.dataKey]?.length || 0;
        break;
        
      case "sms":
        result = await getSMSRecords(
          dateFrom ? `${dateFrom} 00:00:00` : null,
          dateTo ? `${dateTo} 23:59:59` : null,
          { client, number, cli }
        );
        metadata.count = result[capturedStructure.dataTableFormat.dataKey]?.length || 0;
        break;
        
      case "reports":
        // Get reports page HTML
        result = await makeRequest("GET", "/agent/SMSCDRReports");
        metadata.type = "html";
        break;
        
      case "stats":
        result = await makeRequest("GET", "/agent/SMSCDRStats");
        metadata.type = "html";
        break;
        
      case "structure":
        // Force re-detect structure
        await detectSiteStructure();
        result = capturedStructure;
        break;
        
      default:
        return res.json({ error: "Invalid type" });
    }

    res.json({
      success: true,
      ...metadata,
      data: result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("[API Error]", error);
    res.json({ 
      success: false,
      error: error.message || "Failed to fetch data",
      type: type,
      auto_correct_suggestion: "Try ?type=structure to re-detect"
    });
  }
});

/* Manual capture update */
router.post("/capture", async (req, res) => {
  try {
    const newStructure = await detectSiteStructure();
    res.json({
      success: true,
      message: "Structure re-captured",
      structure: newStructure
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

/* Login status */
router.get("/status", async (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    cookies: cookies.length,
    username: CONFIG.username,
    baseUrl: CONFIG.baseUrl,
    captured_structure: capturedStructure
  });
});

/* Force re-login */
router.post("/relogin", async (req, res) => {
  try {
    await login(true);
    res.json({ 
      success: true, 
      message: "Re-login successful",
      structure: capturedStructure
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

module.exports = router;
