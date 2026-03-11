const express = require('express');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const router = express.Router();

// --- CONFIGURATION (AGENT) ---
const CREDENTIALS = {
    username: "RAHMAN3333",
    password: "RAHMAN3333"
};

const BASE_URL = "http://185.2.83.39/ints";

// --- COOKIE JAR FOR AUTOMATIC COOKIE HANDLING ---
const cookieJar = new CookieJar();
const client = wrapper(axios.create({
    jar: cookieJar,
    withCredentials: true,
    maxRedirects: 0,
    timeout: 10000
}));

// --- GLOBAL STATE ---
let STATE = {
    sessKey: null,
    isLoggingIn: false,
    lastLogin: null
};

// --- HEADERS (EXACT MATCH WITH BROWSER) ---
const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
};

const AJAX_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.120 Mobile Safari/537.36",
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive"
};

// --- HELPER FUNCTIONS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function extractSessKey(html) {
    // Multiple patterns to find sesskey
    const patterns = [
        /sesskey\s*=\s*["']([^"']+)["']/i,
        /sesskey=([^&"'\s]+)/i,
        /name="sesskey"\s+value="([^"]+)"/i,
        /sesskey[=:]\s*["']?([^"'\s&]+)["']?/i
    ];
    
    for (let pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1];
    }
    
    // Try to find in script tags
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatch) {
        for (let script of scriptMatch) {
            const m = script.match(/sesskey["']?\s*[:=]\s*["']([^"']+)["']/i);
            if (m) return m[1];
        }
    }
    
    return null;
}

function cleanHtml(text) {
    return (text || "").replace(/<[^>]+>/g, "").trim();
}

// --- FIX NUMBERS DATA ---
function fixNumbers(data) {
    if (!data || !data.aaData) return data;
    
    data.aaData = data.aaData.map(row => [
        row[1], // Number
        "",
        row[3], // Service
        "Weekly",
        cleanHtml(row[4]),
        cleanHtml(row[7])
    ]);
    
    return data;
}

// --- FIX SMS DATA ---
function fixSMS(data) {
    if (!data || !data.aaData) return data;
    
    data.aaData = data.aaData
        .map(row => {
            let message = (row[5] || "")
                .replace(/legendhacker/gi, "")
                .trim();
            
            if (!message) return null;
            
            return [
                row[0], // date
                row[1], // range
                row[2], // number
                row[3], // service
                message, // OTP MESSAGE
                "$",
                row[7] || 0
            ];
        })
        .filter(Boolean);
    
    return data;
}

// --- FAST LOGIN FUNCTION ---
async function performLogin(force = false) {
    // Agar already logged in hai to 45 min tak wait karo
    if (!force && STATE.lastLogin && (Date.now() - STATE.lastLogin) < 45 * 60 * 1000 && STATE.sessKey) {
        console.log("✅ Using existing session");
        return true;
    }
    
    if (STATE.isLoggingIn) {
        console.log("⏳ Login already in progress, waiting...");
        while (STATE.isLoggingIn) {
            await new Promise(r => setTimeout(r, 500));
        }
        return STATE.sessKey ? true : false;
    }
    
    STATE.isLoggingIn = true;
    console.log("🔑 Logging in...");

    try {
        // STEP 1: Clear cookies and get login page
        await cookieJar.removeAllCookies();
        
        const loginPage = await client.get(`${BASE_URL}/login`, {
            headers: COMMON_HEADERS
        });

        // Extract captcha
        const captchaMatch = loginPage.data.match(/What is (\d+) \+ (\d+)/i);
        const captchaAnswer = captchaMatch ? 
            parseInt(captchaMatch[1]) + parseInt(captchaMatch[2]) : 6;

        console.log(`📝 Captcha: ${captchaMatch ? captchaMatch[1] + ' + ' + captchaMatch[2] : 'default'} = ${captchaAnswer}`);

        // STEP 2: Submit login form
        const formData = new URLSearchParams();
        formData.append('username', CREDENTIALS.username);
        formData.append('password', CREDENTIALS.password);
        formData.append('capt', captchaAnswer);

        const loginResult = await client.post(`${BASE_URL}/signin`, formData.toString(), {
            headers: {
                ...COMMON_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": `${BASE_URL}/login`,
                "Origin": "http://185.2.83.39"
            },
            maxRedirects: 0,
            validateStatus: status => status < 400 || status === 302
        });

        // STEP 3: Follow redirect to agent area
        if (loginResult.status === 302 || loginResult.headers.location) {
            const redirectUrl = loginResult.headers.location.startsWith('http') ? 
                loginResult.headers.location : `${BASE_URL}${loginResult.headers.location}`;
            
            await client.get(redirectUrl, {
                headers: COMMON_HEADERS,
                maxRedirects: 2
            });
        } else {
            await client.get(`${BASE_URL}/agent/`, {
                headers: COMMON_HEADERS
            });
        }

        // STEP 4: Get SMSDashboard for sesskey
        const dashboardPage = await client.get(`${BASE_URL}/agent/SMSDashboard`, {
            headers: {
                ...COMMON_HEADERS,
                "Referer": `${BASE_URL}/agent/`
            }
        });

        // Extract sesskey
        const sessKey = extractSessKey(dashboardPage.data);
        
        if (sessKey) {
            STATE.sessKey = sessKey;
            STATE.lastLogin = Date.now();
            console.log("✅ Login successful! SessKey:", sessKey);
            return true;
        } else {
            console.log("⚠️ SessKey not found, but login might still work");
            STATE.sessKey = "dummy";
            STATE.lastLogin = Date.now();
            return true;
        }

    } catch (error) {
        console.error("❌ Login failed:", error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Headers:", error.response.headers);
        }
        STATE.sessKey = null;
        return false;
    } finally {
        STATE.isLoggingIn = false;
    }
}

// --- API ROUTE ---
router.get('/', async (req, res) => {
    const { type } = req.query;
    
    // FAST LOGIN CHECK - sirf ek baar
    if (!STATE.sessKey) {
        const loggedIn = await performLogin();
        if (!loggedIn) {
            return res.status(500).json({ error: "Login failed. Check credentials." });
        }
    }

    const ts = Date.now();
    const today = getTodayDate();
    let targetUrl = "", referer = "";

    if (type === 'numbers') {
        referer = `${BASE_URL}/agent/MySMSNumbers`;
        targetUrl = `${BASE_URL}/agent/res/data_smsnumbers.php?` +
            `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${ts}`;
            
    } else if (type === 'sms') {
        referer = `${BASE_URL}/agent/SMSCDRReports`;
        
        targetUrl = `${BASE_URL}/agent/res/data_smscdr.php?` +
            `fdate1=${today}%2000:00:00&fdate2=2999-12-31%2023:59:59&` +
            `frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&` +
            `fgnumber=&fgcli=&fg=0&sesskey=${STATE.sessKey}&iDisplayLength=5000&_=${ts}`;
            
    } else {
        return res.status(400).json({ 
            error: "Invalid type. Use ?type=numbers or ?type=sms"
        });
    }

    try {
        const response = await client.get(targetUrl, {
            headers: {
                ...AJAX_HEADERS,
                "Referer": referer,
                "Cookie": await cookieJar.getCookieString(targetUrl)
            },
            validateStatus: status => status < 400
        });

        // Check if session expired
        if (typeof response.data === 'string') {
            if (response.data.includes('login') || response.data.includes('Sign In')) {
                console.log("🔄 Session expired, re-logging...");
                STATE.sessKey = null;
                await performLogin(true);
                return res.redirect(req.originalUrl);
            }
        }

        // Parse JSON and apply transformations
        let jsonData;
        try {
            jsonData = typeof response.data === 'string' ? 
                JSON.parse(response.data) : response.data;
        } catch (e) {
            return res.json(response.data);
        }

        // Apply fixes
        if (type === 'numbers') {
            jsonData = fixNumbers(jsonData);
        } else if (type === 'sms') {
            jsonData = fixSMS(jsonData);
        }

        res.json(jsonData);

    } catch (error) {
        console.error("API Error:", error.message);
        
        if (error.response?.status === 403) {
            STATE.sessKey = null;
            await performLogin(true);
            return res.redirect(req.originalUrl);
        }
        
        res.status(500).json({ error: error.message });
    }
});

// --- FAST STATUS CHECK ---
router.get('/status', async (req, res) => {
    res.json({
        loggedIn: !!STATE.sessKey,
        sessKey: STATE.sessKey || null,
        lastLogin: STATE.lastLogin ? new Date(STATE.lastLogin).toISOString() : null,
        cookieCount: (await cookieJar.getCookies(BASE_URL)).length
    });
});

// --- FAST RE-LOGIN ---
router.post('/relogin', async (req, res) => {
    const success = await performLogin(true);
    res.json({ 
        success, 
        message: success ? "Login successful" : "Login failed",
        sessKey: STATE.sessKey 
    });
});

// --- INITIAL LOGIN (FAST) ---
(async () => {
    console.log("🚀 Starting initial login...");
    await performLogin();
})();

module.exports = router;
