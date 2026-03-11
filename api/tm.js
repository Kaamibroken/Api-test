const express = require("express");
const axios = require("axios");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://185.2.83.39/ints",
  username: "RAHMAN3333",
  password: "RAHMAN3333",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

const COMMON_HEADERS = {
  "User-Agent": CONFIG.userAgent,
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate",
  "Accept-Language": "en-PK,en;q=0.9",
  "X-Requested-With": "mark.via.gp",
  "Connection": "keep-alive"
};

let STATE = {
  cookie: null,
  sessKey: null,
  lastLogin: null
};

let loginInProgress = false;

/* ================= SAFE JSON ================= */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from server" };
  }
}

/* ================= EXTRACT SESSKEY ================= */
function extractSessKey(html) {
  const match = html.match(/sesskey\s*=\s*["']([^"']+)["']/i) || 
                html.match(/sesskey=([^&"'\s]+)/i);
  return match ? match[1] : null;
}

/* ================= LOGIN FUNCTION ================= */
async function performLogin(force = false) {
  // Prevent multiple simultaneous login attempts
  if (loginInProgress) {
    console.log("Login already in progress, waiting...");
    while (loginInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return;
  }

  // Check if already logged in (within last 45 minutes)
  if (!force && STATE.lastLogin && (Date.now() - STATE.lastLogin) < 45 * 60 * 1000) {
    console.log("Using existing session");
    return;
  }

  try {
    loginInProgress = true;
    console.log("Performing login...");

    // Step 1: Get login page for captcha
    const loginPage = await axios.get(`${CONFIG.baseUrl}/login`, {
      headers: { 
        ...COMMON_HEADERS,
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1"
      },
      maxRedirects: 0,
      validateStatus: status => status < 400
    });

    // Store cookie from login page
    if (loginPage.headers['set-cookie']) {
      STATE.cookie = loginPage.headers['set-cookie'].join('; ');
    }

    // Extract captcha
    const match = loginPage.data.match(/What is (\d+) \+ (\d+)/i);
    const capt = match ? Number(match[1]) + Number(match[2]) : 6;

    // Step 2: Submit login form
    const formData = querystring.stringify({
      username: CONFIG.username,
      password: CONFIG.password,
      capt
    });

    const loginResult = await axios.post(`${CONFIG.baseUrl}/signin`, formData, {
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${CONFIG.baseUrl}/login`,
        "Origin": "http://185.2.83.39",
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": STATE.cookie || ""
      },
      maxRedirects: 0,
      validateStatus: status => status < 400
    });

    // Update cookie
    if (loginResult.headers['set-cookie']) {
      STATE.cookie = loginResult.headers['set-cookie'].join('; ');
    }

    // Step 3: Go to agent area
    const agentPage = await axios.get(`${CONFIG.baseUrl}/agent/`, {
      headers: {
        ...COMMON_HEADERS,
        "Referer": `${CONFIG.baseUrl}/login`,
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": STATE.cookie || ""
      }
    });

    // Step 4: Get SMSDashboard for sesskey
    const dashboardPage = await axios.get(`${CONFIG.baseUrl}/agent/SMSDashboard`, {
      headers: {
        ...COMMON_HEADERS,
        "Referer": `${CONFIG.baseUrl}/agent/`,
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": STATE.cookie || ""
      }
    });

    // Extract sesskey
    STATE.sessKey = extractSessKey(dashboardPage.data);
    STATE.lastLogin = Date.now();
    
    console.log("Login successful! SessKey:", STATE.sessKey);
    
  } catch (error) {
    console.error("Login failed:", error.message);
    STATE.cookie = null;
    STATE.sessKey = null;
    throw error;
  } finally {
    loginInProgress = false;
  }
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[0], // ID
    row[1], // Number
    row[2], // Client
    row[3], // Service
    (row[4] || "").replace(/<[^>]+>/g, "").trim(),
    (row[5] || "").replace(/<[^>]+>/g, "").trim(),
    (row[6] || "").replace(/<[^>]+>/g, "").trim(),
    (row[7] || "").replace(/<[^>]+>/g, "").trim()
  ]);

  return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[0], // Date
    row[1], // Range
    row[2], // Number
    row[3], // Client
    row[4], // Source
    (row[5] || "").replace(/<[^>]+>/g, "").trim(),
    row[6], // Type
    (row[7] || "").replace(/<[^>]+>/g, "").trim(),
    (row[8] || "").replace(/<[^>]+>/g, "").trim()
  ]);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function fetchNumbers() {
  // Visit MySMSNumbers page first
  await axios.get(`${CONFIG.baseUrl}/agent/MySMSNumbers`, {
    headers: {
      ...COMMON_HEADERS,
      "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
      "Cookie": STATE.cookie || ""
    }
  });

  const timestamp = Date.now();
  const url = `${CONFIG.baseUrl}/agent/res/data_smsnumbers.php?` +
    `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${timestamp}`;

  const response = await axios.get(url, {
    headers: {
      ...COMMON_HEADERS,
      "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": STATE.cookie || ""
    }
  });

  return fixNumbers(safeJSON(response.data));
}

/* ================= FETCH SMS ================= */
async function fetchSMS(fdate2 = null) {
  // Visit SMSCDRReports page first
  await axios.get(`${CONFIG.baseUrl}/agent/SMSCDRReports`, {
    headers: {
      ...COMMON_HEADERS,
      "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
      "Cookie": STATE.cookie || ""
    }
  });

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const fdate1 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
  const fdate2Final = fdate2 || `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")} 23:59:59`;

  const timestamp = Date.now();
  
  // Build URL with all parameters including sesskey
  const url = `${CONFIG.baseUrl}/agent/res/data_smscdr.php?` +
    `fdate1=${encodeURIComponent(fdate1)}&fdate2=${encodeURIComponent(fdate2Final)}&` +
    `frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&` +
    `fgnumber=&fgcli=&fg=0&sesskey=${STATE.sessKey || ''}&sEcho=1&iColumns=9&` +
    `sColumns=%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000&` +
    `mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&` +
    `mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&` +
    `mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&` +
    `mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&` +
    `mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&` +
    `mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&` +
    `mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&` +
    `mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&` +
    `mDataProp_8=8&sSearch_8=&bRegex_8=false&bSearchable_8=true&bSortable_8=false&` +
    `sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${timestamp}`;

  const response = await axios.get(url, {
    headers: {
      ...COMMON_HEADERS,
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": STATE.cookie || ""
    }
  });

  return fixSMS(safeJSON(response.data));
}

/* ================= MAIN API ENDPOINT ================= */
router.get("/", async (req, res) => {
  const { type, fdate2 } = req.query;

  if (!type || (type !== "numbers" && type !== "sms")) {
    return res.status(400).json({ 
      error: "Invalid type. Use ?type=numbers or ?type=sms" 
    });
  }

  try {
    // Ensure we're logged in
    if (!STATE.cookie || !STATE.sessKey) {
      await performLogin();
    }

    let result;
    let referer;

    if (type === "numbers") {
      referer = `${CONFIG.baseUrl}/agent/MySMSNumbers`;
      result = await fetchNumbers();
    } else {
      referer = `${CONFIG.baseUrl}/agent/SMSCDRReports`;
      result = await fetchSMS(fdate2);
    }

    // Check if response indicates session expired
    if (result.error || (typeof result === 'string' && result.includes('login'))) {
      STATE.cookie = null;
      STATE.sessKey = null;
      await performLogin();
      
      // Retry once after login
      if (type === "numbers") {
        result = await fetchNumbers();
      } else {
        result = await fetchSMS(fdate2);
      }
    }

    res.set('Content-Type', 'application/json');
    res.json(result);

  } catch (error) {
    console.error("API Error:", error.message);
    
    // Handle session expiry (403 or redirect to login)
    if (error.response) {
      if (error.response.status === 403 || 
          (error.response.data && error.response.data.includes('login'))) {
        
        STATE.cookie = null;
        STATE.sessKey = null;
        
        try {
          await performLogin();
          // Don't auto-redirect, just return message
          return res.status(503).json({ 
            error: "Session expired. Please try again.",
            retry: true 
          });
        } catch (loginError) {
          return res.status(500).json({ error: "Re-login failed" });
        }
      }
    }
    
    res.status(500).json({ error: error.message });
  }
});

/* ================= SESSION STATUS ENDPOINT ================= */
router.get("/status", (req, res) => {
  res.json({
    loggedIn: !!(STATE.cookie && STATE.sessKey),
    hasCookie: !!STATE.cookie,
    hasSessKey: !!STATE.sessKey,
    sessKey: STATE.sessKey || null,
    lastLogin: STATE.lastLogin ? new Date(STATE.lastLogin).toISOString() : null,
    sessionAge: STATE.lastLogin ? Math.round((Date.now() - STATE.lastLogin) / 1000) + "s" : "N/A"
  });
});

/* ================= FORCE RE-LOGIN ENDPOINT ================= */
router.post("/relogin", async (req, res) => {
  try {
    await performLogin(true);
    res.json({ success: true, message: "Re-login successful" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- INITIAL LOGIN ---
performLogin().catch(console.error);

module.exports = router;
