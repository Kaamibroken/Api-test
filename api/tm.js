const express = require("express");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");

const router = express.Router();

const CONFIG = {
  baseUrl: "http://185.2.83.39/ints",
  username: "RAHMAN3333",
  password: "RAHMAN3333",
  userAgent: "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36"
};

let cookies = [];
let sesskey = "";
let lastLoginTime = null;
let isRefreshing = false;

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
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "X-Requested-With": "mark.via.gp",
      "Cookie": cookies.join("; "),
      ...extraHeaders
    };

    if (method === "POST" && data) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
    }

    const req = lib.request(url, { method, headers }, res => {
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const cookie = c.split(";")[0];
          if (!cookies.includes(cookie)) {
            cookies.push(cookie);
          }
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
        
        const bodyStr = buffer.toString();
        
        // Check if session expired (redirect to login)
        if (bodyStr.includes('login') || bodyStr.includes('Sign In')) {
          reject(new Error("SESSION_EXPIRED"));
          return;
        }
        
        resolve(bodyStr);
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ================= LOGIN ================= */
async function login(force = false) {
  // Check if already logged in within last 45 minutes
  if (!force && lastLoginTime && (Date.now() - lastLoginTime) < 45 * 60 * 1000) {
    return true;
  }

  cookies = [];
  sesskey = "";

  try {
    // Get login page
    const page = await request("GET", `${CONFIG.baseUrl}/login`, null, {
      "X-Requested-With": "mark.via.gp"
    });

    // Extract math captcha
    const match = page.match(/What is (\d+) \+ (\d+)/i);
    const capt = match ? Number(match[1]) + Number(match[2]) : 6;

    const form = querystring.stringify({
      username: CONFIG.username,
      password: CONFIG.password,
      capt
    });

    // Submit login
    await request(
      "POST",
      `${CONFIG.baseUrl}/signin`,
      form,
      { 
        "Referer": `${CONFIG.baseUrl}/login`,
        "X-Requested-With": "mark.via.gp"
      }
    );

    // Go to agent area
    await request("GET", `${CONFIG.baseUrl}/agent/`, null, {
      "Referer": `${CONFIG.baseUrl}/login`,
      "X-Requested-With": "mark.via.gp"
    });

    // Go to SMS Dashboard to get sesskey
    const dashboardPage = await request("GET", `${CONFIG.baseUrl}/agent/SMSDashboard`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/`,
      "X-Requested-With": "mark.via.gp"
    });

    // Extract sesskey
    const sesskeyMatch = dashboardPage.match(/sesskey\s*=\s*["']([^"']+)["']/i) || 
                        dashboardPage.match(/sesskey=([^&"'\s]+)/i);
    
    if (sesskeyMatch) {
      sesskey = sesskeyMatch[1];
    }

    lastLoginTime = Date.now();
    console.log("Login successful, sesskey:", sesskey);
    return true;
  } catch (error) {
    console.error("Login failed:", error.message);
    throw error;
  }
}

/* ================= REFRESH SESSION IF NEEDED ================= */
async function refreshSessionIfNeeded() {
  if (isRefreshing) {
    // Wait for ongoing refresh
    while (isRefreshing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return;
  }

  try {
    isRefreshing = true;
    await login(true); // Force login
  } finally {
    isRefreshing = false;
  }
}

/* ================= EXECUTE WITH AUTO RE-LOGIN ================= */
async function executeWithAutoRelogin(action) {
  let retries = 2;
  
  while (retries > 0) {
    try {
      // Ensure we're logged in
      await login();
      
      // Execute the action
      const result = await action();
      return result;
      
    } catch (error) {
      if (error.message === "SESSION_EXPIRED" && retries > 0) {
        console.log("Session expired, re-logging in...");
        await refreshSessionIfNeeded();
        retries--;
      } else {
        throw error;
      }
    }
  }
  
  throw new Error("Max retries exceeded");
}

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
  if (!data.aaData) return data;

  data.aaData = data.aaData.map(row => [
    row[0], // ID
    row[1], // Number
    row[2], // Client
    row[3], // Service
    (row[4] || "").replace(/<[^>]+>/g, "").trim(), // Expiry
    (row[5] || "").replace(/<[^>]+>/g, "").trim(), // Status
    (row[6] || "").replace(/<[^>]+>/g, "").trim(), // Notes
    (row[7] || "").replace(/<[^>]+>/g, "").trim()  // Actions
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
    (row[5] || "").replace(/<[^>]+>/g, "").trim(), // Message
    row[6], // Type
    (row[7] || "").replace(/<[^>]+>/g, "").trim(), // Status
    (row[8] || "").replace(/<[^>]+>/g, "").trim()  // Actions
  ]);

  return data;
}

/* ================= FETCH NUMBERS ================= */
async function getNumbers() {
  return executeWithAutoRelogin(async () => {
    // Visit MySMSNumbers page first
    await request("GET", `${CONFIG.baseUrl}/agent/MySMSNumbers`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
      "X-Requested-With": "mark.via.gp"
    });

    const timestamp = Date.now();
    const url =
      `${CONFIG.baseUrl}/agent/res/data_smsnumbers.php?` +
      `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${timestamp}`;

    const data = await request("GET", url, null, {
      "Referer": `${CONFIG.baseUrl}/agent/MySMSNumbers`,
      "X-Requested-With": "XMLHttpRequest"
    });

    return fixNumbers(safeJSON(data));
  });
}

/* ================= FETCH SMS ================= */
async function getSMS(fdate2 = null) {
  return executeWithAutoRelogin(async () => {
    const today = new Date();
    
    let fdate1, fdate2Final;
    
    if (fdate2) {
      // Custom date range
      fdate1 = `2026-03-11 00:00:00`; // You can make this dynamic too
      fdate2Final = fdate2;
    } else {
      // Default: today to tomorrow
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      fdate1 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
      fdate2Final = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")} 23:59:59`;
    }

    // Visit SMSCDRReports page first
    await request("GET", `${CONFIG.baseUrl}/agent/SMSCDRReports`, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSDashboard`,
      "X-Requested-With": "mark.via.gp"
    });

    const timestamp = Date.now();
    
    // Build full URL with all parameters including sesskey
    const url = `${CONFIG.baseUrl}/agent/res/data_smscdr.php?` +
      `fdate1=${encodeURIComponent(fdate1)}&fdate2=${encodeURIComponent(fdate2Final)}&` +
      `frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&` +
      `fgnumber=&fgcli=&fg=0&sesskey=${encodeURIComponent(sesskey)}&sEcho=1&iColumns=9&` +
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

    const data = await request("GET", url, null, {
      "Referer": `${CONFIG.baseUrl}/agent/SMSCDRReports`,
      "X-Requested-With": "XMLHttpRequest"
    });

    return fixSMS(safeJSON(data));
  });
}

/* ================= API ROUTE ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;

  if (!type) {
    return res.json({ error: "Use ?type=numbers or ?type=sms" });
  }

  try {
    if (type === "numbers") {
      const result = await getNumbers();
      return res.json(result);
    }
    
    if (type === "sms") {
      // You can also accept custom fdate2 parameter
      const { fdate2 } = req.query;
      const result = await getSMS(fdate2);
      return res.json(result);
    }

    res.json({ error: "Invalid type" });
  } catch (err) {
    console.error("API Error:", err);
    res.json({ error: err.message });
  }
});

/* ================= SESSION STATUS ENDPOINT ================= */
router.get("/status", (req, res) => {
  res.json({
    loggedIn: cookies.length > 0,
    sesskey: sesskey || "none",
    lastLogin: lastLoginTime ? new Date(lastLoginTime).toISOString() : null,
    sessionAge: lastLoginTime ? Math.round((Date.now() - lastLoginTime) / 1000) + " seconds" : "N/A"
  });
});

module.exports = router;
