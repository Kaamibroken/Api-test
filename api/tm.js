const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION (AGENT) ---
const CREDENTIALS = {
    username: "RAHMAN3333",
    password: "RAHMAN3333"
};

const BASE_URL = "http://185.2.83.39/ints";
const STATS_PAGE_URL = `${BASE_URL}/agent/SMSCDRReports`; // Agent ka stats page

const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "mark.via.gp", // Agent panel mein ye header use hota hai
    "Origin": BASE_URL,
    "Accept-Language": "en-US,en;q=0.9,ur-PK;q=0.8,ur;q=0.7",
    "Accept": "*/*",
    "Connection": "keep-alive"
};

// --- GLOBAL STATE ---
let STATE = {
    cookie: null,
    sessKey: null,
    isLoggingIn: false
};

// --- HELPER FUNCTIONS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function extractKey(html) {
    // Agent panel mein sesskey nikalne ke multiple tarike
    let match = html.match(/sesskey\s*=\s*["']([^"']+)["']/i);
    if (match) return match[1];
    
    match = html.match(/sesskey=([^&"'\s]+)/i);
    if (match) return match[1];
    
    match = html.match(/name="sesskey"\s+value="([^"]+)"/i);
    if (match) return match[1];
    
    return null;
}

// --- CLEAN HTML TAGS (same as original code) ---
function cleanHtml(text) {
    return (text || "").replace(/<[^>]+>/g, "").trim();
}

// --- FIX NUMBERS DATA (same as original) ---
function fixNumbers(data) {
    if (!data.aaData) return data;
    
    data.aaData = data.aaData.map(row => [
        row[1], // Number (as per original code)
        "",
        row[3], // Service
        "Weekly",
        cleanHtml(row[4]),
        cleanHtml(row[7])
    ]);
    
    return data;
}

// --- FIX SMS DATA (same as original) ---
function fixSMS(data) {
    if (!data.aaData) return data;
    
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

// --- LOGIN & FETCH COOKIE + SESSKEY (Agent Version) ---
async function performLogin() {
    if (STATE.isLoggingIn) return;
    STATE.isLoggingIn = true;

    try {
        console.log("🔑 Agent logging in...");
        
        // Step 1: Get login page for captcha
        const instance = axios.create({ 
            headers: COMMON_HEADERS, 
            timeout: 15000, 
            withCredentials: true,
            maxRedirects: 0,
            validateStatus: status => status < 400
        });

        const r1 = await instance.get(`${BASE_URL}/login`);

        let tempCookie = "";
        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) tempCookie = c.split(';')[0];
        }

        // Extract math captcha (What is X + Y)
        const match = r1.data.match(/What is (\d+) \+ (\d+)/i);
        const ans = match ? parseInt(match[1]) + parseInt(match[2]) : 6;

        // Step 2: Submit login form
        const r2 = await instance.post(`${BASE_URL}/signin`, new URLSearchParams({
            username: CREDENTIALS.username,
            password: CREDENTIALS.password,
            capt: ans
        }), {
            headers: { 
                "Content-Type": "application/x-www-form-urlencoded", 
                "Cookie": tempCookie, 
                "Referer": `${BASE_URL}/login`,
                "X-Requested-With": "mark.via.gp"
            },
            maxRedirects: 0,
            validateStatus: () => true
        });

        // Update cookie
        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            STATE.cookie = newC ? newC.split(';')[0] : tempCookie;
        } else {
            STATE.cookie = tempCookie;
        }

        // Step 3: Visit agent area to establish session
        await axios.get(`${BASE_URL}/agent/`, { 
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie, 
                "Referer": `${BASE_URL}/login`,
                "X-Requested-With": "mark.via.gp"
            } 
        });

        // Step 4: Get SMSDashboard for sesskey
        const r3 = await axios.get(`${BASE_URL}/agent/SMSDashboard`, { 
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie, 
                "Referer": `${BASE_URL}/agent/`,
                "X-Requested-With": "mark.via.gp"
            } 
        });
        
        const key = extractKey(r3.data);
        if (key) {
            STATE.sessKey = key;
            console.log("✅ Agent login successful! SessKey:", key);
        } else {
            console.log("⚠️ SessKey not found in dashboard");
        }

    } catch(e) {
        console.error("❌ Agent login failed:", e.message);
        STATE.cookie = null;
        STATE.sessKey = null;
    } finally {
        STATE.isLoggingIn = false;
    }
}

// --- AUTO REFRESH LOGIN EVERY 45 MINUTES (since session expires in 1 hour) ---
setInterval(() => performLogin(), 45 * 60 * 1000); // 45 minutes

// --- API ROUTE ---
router.get('/', async (req, res) => {
    const { type } = req.query;
    
    // Ensure we're logged in
    if (!STATE.cookie || !STATE.sessKey) {
        await performLogin();
        if (!STATE.sessKey) return res.status(500).json({ error: "Waiting for login..." });
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
        
        // Agent panel mein fdate2 2999-12-31 tak set hai
        targetUrl = `${BASE_URL}/agent/res/data_smscdr.php?` +
            `fdate1=${today}%2000:00:00&fdate2=2999-12-31%2023:59:59&` +
            `frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&` +
            `fgnumber=&fgcli=&fg=0&sesskey=${STATE.sessKey}&sEcho=1&iColumns=9&` +
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
            `sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
            
    } else {
        return res.status(400).json({ 
            error: "Invalid type. Use ?type=numbers or ?type=sms",
            example: {
                numbers: "/?type=numbers",
                sms: "/?type=sms"
            }
        });
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie, 
                "Referer": referer,
                "X-Requested-With": type === 'numbers' ? "XMLHttpRequest" : "mark.via.gp"
            },
            timeout: 30000
        });

        // Check if session expired (redirect to login)
        if (typeof response.data === 'string' && 
            (response.data.includes('<html') || 
             response.data.includes('login') || 
             response.data.includes('Sign In'))) {
            
            console.log("🔄 Session expired, re-logging...");
            STATE.cookie = null;
            STATE.sessKey = null;
            await performLogin();
            return res.status(503).json({ 
                error: "Session expired. Please try again.",
                retry: true 
            });
        }

        // Apply transformations based on type
        let resultData = response.data;
        if (type === 'numbers') {
            const parsed = typeof resultData === 'string' ? JSON.parse(resultData) : resultData;
            resultData = fixNumbers(parsed);
        } else if (type === 'sms') {
            const parsed = typeof resultData === 'string' ? JSON.parse(resultData) : resultData;
            resultData = fixSMS(parsed);
        }

        res.set('Content-Type', 'application/json');
        res.json(resultData);

    } catch (e) {
        console.error("API Error:", e.message);
        
        // Handle 403 Forbidden (session expired)
        if (e.response && e.response.status === 403) {
            STATE.cookie = null;
            STATE.sessKey = null;
            await performLogin();
            return res.status(503).json({ 
                error: "Session expired. Please try again.",
                retry: true 
            });
        }
        
        res.status(500).json({ error: e.message });
    }
});

// --- SESSION STATUS ENDPOINT ---
router.get('/status', (req, res) => {
    res.json({
        loggedIn: !!(STATE.cookie && STATE.sessKey),
        hasCookie: !!STATE.cookie,
        hasSessKey: !!STATE.sessKey,
        sessKey: STATE.sessKey || null,
        lastLogin: global.lastLoginTime ? new Date(global.lastLoginTime).toISOString() : null
    });
});

// --- FORCE RE-LOGIN ENDPOINT ---
router.post('/relogin', async (req, res) => {
    try {
        await performLogin();
        res.json({ success: true, message: "Re-login successful" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- EXPORT ROUTER ---
module.exports = router;

// --- INITIAL LOGIN ---
performLogin();
