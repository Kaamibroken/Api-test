const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION (Agent) ---
const CREDENTIALS = {
    username: "RAHMAN3333",
    password: "RAHMAN3333"
};

const BASE_URL = "http://185.2.83.39/ints";

// IMPORTANT: URLs check karo - Agent hai ya agent? (Case sensitive)
// Aapke code mein "Agent" capital A hai, lekin original mein "agent" small a hai
const AGENT_PATH = "/agent"; // small 'a' use karo
const STATS_PAGE_URL = `${BASE_URL}${AGENT_PATH}/SMSCDRReports`; // Reports hai na Stats?

const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "mark.via.gp", // XMLHttpRequest ki jagah mark.via.gp use karo
    "Origin": BASE_URL,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,ur-PK;q=0.8,ur;q=0.7",
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
    console.log("🔍 Extracting sesskey from HTML...");
    
    // Multiple patterns try karo
    let match = html.match(/sesskey\s*=\s*["']([^"']+)["']/i);
    if (match) {
        console.log("✅ Found sesskey (pattern 1):", match[1]);
        return match[1];
    }
    
    match = html.match(/sesskey=([^&"'\s]+)/i);
    if (match) {
        console.log("✅ Found sesskey (pattern 2):", match[1]);
        return match[1];
    }
    
    match = html.match(/name="sesskey"\s+value="([^"]+)"/i);
    if (match) {
        console.log("✅ Found sesskey (pattern 3):", match[1]);
        return match[1];
    }
    
    // Script tags mein dhoondo
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatch) {
        for (let script of scriptMatch) {
            const m = script.match(/sesskey["']?\s*[:=]\s*["']([^"']+)["']/i);
            if (m) {
                console.log("✅ Found sesskey in script:", m[1]);
                return m[1];
            }
        }
    }
    
    console.log("❌ No sesskey found in HTML");
    return null;
}

// --- LOGIN & FETCH COOKIE + SESSKEY (WITH DEBUGGING) ---
async function performLogin() {
    if (STATE.isLoggingIn) {
        console.log("⏳ Login already in progress...");
        return;
    }
    
    STATE.isLoggingIn = true;
    console.log("🔑 Starting login process...");

    try {
        // Step 1: Get login page
        console.log("📞 Getting login page...");
        const r1 = await axios.get(`${BASE_URL}/login`, {
            headers: COMMON_HEADERS,
            timeout: 15000
        });
        
        console.log("✅ Login page received, status:", r1.status);

        // Store cookie
        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) {
                STATE.cookie = c.split(';')[0];
                console.log("🍪 Cookie saved:", STATE.cookie);
            }
        }

        // Extract captcha
        console.log("🧮 Extracting captcha...");
        const match = r1.data.match(/What is (\d+) \+ (\d+)/i);
        let ans = 6; // Default
        
        if (match) {
            ans = parseInt(match[1]) + parseInt(match[2]);
            console.log(`✅ Captcha: ${match[1]} + ${match[2]} = ${ans}`);
        } else {
            console.log("⚠️ Captcha pattern not found, using default:", ans);
            // Pehle 100 characters print karo debug ke liye
            console.log("HTML preview:", r1.data.substring(0, 500));
        }

        // Step 2: Submit login form
        console.log("📤 Submitting login form...");
        const formData = new URLSearchParams();
        formData.append('username', CREDENTIALS.username);
        formData.append('password', CREDENTIALS.password);
        formData.append('capt', ans);

        const r2 = await axios.post(`${BASE_URL}/signin`, formData.toString(), {
            headers: { 
                "Content-Type": "application/x-www-form-urlencoded", 
                "Cookie": STATE.cookie || "", 
                "Referer": `${BASE_URL}/login`,
                "X-Requested-With": "mark.via.gp",
                "Origin": BASE_URL
            },
            maxRedirects: 0,
            validateStatus: status => status < 400 || status === 302,
            timeout: 15000
        });

        console.log("✅ Login form submitted, status:", r2.status);
        
        // Update cookie
        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (newC) {
                STATE.cookie = newC.split(';')[0];
                console.log("🍪 Cookie updated:", STATE.cookie);
            }
        }

        // Step 3: Visit agent area
        console.log("📞 Visiting agent area...");
        try {
            await axios.get(`${BASE_URL}${AGENT_PATH}/`, {
                headers: { 
                    ...COMMON_HEADERS, 
                    "Cookie": STATE.cookie, 
                    "Referer": `${BASE_URL}/login`
                },
                timeout: 15000
            });
            console.log("✅ Agent area visited");
        } catch (e) {
            console.log("⚠️ Agent area visit issue:", e.message);
        }

        // Step 4: Get SMSDashboard for sesskey
        console.log("📞 Getting SMSDashboard...");
        let r3;
        try {
            r3 = await axios.get(`${BASE_URL}${AGENT_PATH}/SMSDashboard`, {
                headers: { 
                    ...COMMON_HEADERS, 
                    "Cookie": STATE.cookie, 
                    "Referer": `${BASE_URL}${AGENT_PATH}/`
                },
                timeout: 15000
            });
            console.log("✅ SMSDashboard received");
        } catch (e) {
            console.log("⚠️ SMSDashboard error:", e.message);
            // Try alternative URL
            r3 = await axios.get(`${BASE_URL}/agent/SMSDashboard`, {
                headers: { 
                    ...COMMON_HEADERS, 
                    "Cookie": STATE.cookie
                },
                timeout: 15000
            });
        }

        const key = extractKey(r3.data);
        if (key) {
            STATE.sessKey = key;
            console.log("✅ Login successful! SessKey:", STATE.sessKey);
        } else {
            console.log("⚠️ Login successful but no sesskey found");
            // Try to find sesskey in response
            console.log("Response preview:", r3.data.substring(0, 300));
        }

    } catch(e) {
        console.error("❌ Login failed:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Headers:", e.response.headers);
        }
        STATE.cookie = null;
        STATE.sessKey = null;
    } finally {
        STATE.isLoggingIn = false;
    }
}

// --- AUTO REFRESH LOGIN EVERY 30 MINUTES ---
setInterval(() => performLogin(), 30 * 60 * 1000);

// --- API ROUTE ---
router.get('/', async (req,res)=>{
    const { type } = req.query;
    
    console.log(`📡 Request received: type=${type}`);
    
    // Check login status
    if (!STATE.cookie || !STATE.sessKey) {
        console.log("⏳ No session, logging in...");
        await performLogin();
        
        // Double check after login
        if (!STATE.sessKey) {
            console.log("❌ Still no sesskey after login");
            return res.status(500).json({ 
                error: "Login failed. Check server logs.",
                details: "Sesskey not found"
            });
        }
    }

    const ts = Date.now();
    const today = getTodayDate();
    let targetUrl = "", referer = "";

    if (type === 'numbers') {
        referer = `${BASE_URL}${AGENT_PATH}/MySMSNumbers`;
        targetUrl = `${BASE_URL}${AGENT_PATH}/res/data_smsnumbers.php?` +
            `frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${ts}`;
            
    } else if (type === 'sms') {
        referer = `${BASE_URL}${AGENT_PATH}/SMSCDRReports`;
        
        // Original URL pattern match karo
        targetUrl = `${BASE_URL}${AGENT_PATH}/res/data_smscdr.php?` +
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
            error: "Invalid type. Use ?type=numbers or ?type=sms" 
        });
    }

    console.log(`🌐 Fetching: ${type}`);
    console.log(`🔗 URL: ${targetUrl.substring(0, 200)}...`);

    try {
        const response = await axios.get(targetUrl, {
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie, 
                "Referer": referer,
                "X-Requested-With": "XMLHttpRequest"
            },
            timeout: 30000
        });

        console.log(`✅ Response received, status: ${response.status}`);

        // Check if session expired
        if (typeof response.data === 'string') {
            if (response.data.includes('<html') || 
                response.data.includes('login') || 
                response.data.includes('Sign In')) {
                
                console.log("🔄 Session expired, re-logging...");
                STATE.cookie = null;
                STATE.sessKey = null;
                await performLogin();
                return res.status(503).json({ 
                    error: "Session expired. Please try again.",
                    retry: true 
                });
            }
        }

        res.set('Content-Type', 'application/json');
        res.send(response.data);

    } catch(e) {
        console.error("❌ API Error:", e.message);
        
        if (e.response) {
            console.error("Status:", e.response.status);
            
            if (e.response.status === 403) {
                STATE.cookie = null;
                STATE.sessKey = null;
                await performLogin();
                return res.status(503).json({ 
                    error: "Session expired. Please try again.",
                    retry: true 
                });
            }
        }
        
        res.status(500).json({ error: e.message });
    }
});

// --- STATUS ENDPOINT (FOR DEBUGGING) ---
router.get('/status', (req, res) => {
    res.json({
        loggedIn: !!(STATE.cookie && STATE.sessKey),
        hasCookie: !!STATE.cookie,
        hasSessKey: !!STATE.sessKey,
        sessKey: STATE.sessKey || null,
        cookie: STATE.cookie ? STATE.cookie.substring(0, 30) + '...' : null,
        isLoggingIn: STATE.isLoggingIn
    });
});

// --- FORCE RE-LOGIN ---
router.post('/relogin', async (req, res) => {
    STATE.cookie = null;
    STATE.sessKey = null;
    await performLogin();
    res.json({ 
        success: !!STATE.sessKey,
        sessKey: STATE.sessKey 
    });
});

// --- EXPORT ROUTER ---
module.exports = router;

// --- INITIAL LOGIN ---
console.log("🚀 Starting initial login...");
setTimeout(() => performLogin(), 1000);
