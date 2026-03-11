const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION ---
const CREDENTIALS = {
    username: "RAHMAN3333",
    password: "RAHMAN3333"
};

const BASE_URL = "http://185.2.83.39/ints";
const STATS_PAGE_URL = `${BASE_URL}/Agent/SMSCDRStats`;

const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": BASE_URL,
    "Accept-Language": "en-US,en;q=0.9,ur-PK;q=0.8,ur;q=0.7"
};

// --- GLOBAL STATE ---
let STATE = {
    cookie: null,
    sessKey: null,
    loginPromise: null  // ✅ FIX: Promise store karo taake sab await kar sakein
};

// --- HELPERS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function extractKey(html) {
    // Multiple patterns try karo
    const patterns = [
        /sesskey=([A-Za-z0-9+/=]+)/,
        /sesskey\s*[:=]\s*["']([^"']+)["']/,
        /[?&]sesskey=([^&"'\s]+)/,
        /sesskey","([^"]+)"/,
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1]) {
            console.log(`✅ sessKey found: ${m[1].substring(0,20)}...`);
            return m[1];
        }
    }
    // Debug: pehle 2000 chars print karo
    console.error("❌ sessKey not found in HTML. Sample:", html.substring(0, 2000));
    return null;
}

// --- CORE LOGIN FUNCTION ---
function performLogin() {
    // ✅ FIX: Agar already login ho raha hai toh wahi promise return karo
    if (STATE.loginPromise) {
        console.log("⏳ Login already in progress, waiting...");
        return STATE.loginPromise;
    }

    STATE.loginPromise = _doLogin().finally(() => {
        STATE.loginPromise = null; // Done hone ke baad clear karo
    });

    return STATE.loginPromise;
}

async function _doLogin() {
    console.log("🔐 Starting login...");

    const instance = axios.create({
        headers: COMMON_HEADERS,
        timeout: 20000,
        withCredentials: true
    });

    // Step 1: GET login page (session cookie + captcha)
    let tempCookie = "";
    try {
        const r1 = await instance.get(`${BASE_URL}/login`);
        console.log("📄 Login page fetched. Status:", r1.status);

        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) {
                tempCookie = c.split(';')[0];
                console.log("🍪 Initial cookie:", tempCookie);
            }
        }

        // Captcha solve karo
        const match = r1.data.match(/What is\s+(\d+)\s*\+\s*(\d+)/i);
        const ans = match ? parseInt(match[1]) + parseInt(match[2]) : 4;
        console.log("🔢 Captcha answer:", ans, match ? `(${match[1]}+${match[2]})` : "(fallback=4)");

        // Step 2: POST signin
        const r2 = await instance.post(
            `${BASE_URL}/signin`,
            new URLSearchParams({
                username: CREDENTIALS.username,
                password: CREDENTIALS.password,
                capt: String(ans)
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": tempCookie,
                    "Referer": `${BASE_URL}/login`
                },
                maxRedirects: 0,
                validateStatus: () => true
            }
        );

        console.log("📬 Signin response status:", r2.status);
        console.log("📬 Signin headers:", JSON.stringify(r2.headers['set-cookie'] || []));

        // Cookie update karo
        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            STATE.cookie = newC ? newC.split(';')[0] : tempCookie;
        } else {
            STATE.cookie = tempCookie;
        }
        console.log("🍪 Final cookie:", STATE.cookie);

    } catch (e) {
        console.error("❌ Login step 1/2 failed:", e.message);
        throw e;
    }

    // Step 3: sessKey fetch karo
    try {
        const r3 = await axios.get(STATS_PAGE_URL, {
            headers: {
                ...COMMON_HEADERS,
                "Cookie": STATE.cookie,
                "Referer": `${BASE_URL}/Agent/SMSDashboard`
            },
            timeout: 20000
        });

        console.log("📄 Stats page status:", r3.status);

        // Agar redirect ya login page aa jaye
        if (r3.data && (r3.data.includes('id="loginform"') || r3.data.includes('/ints/login'))) {
            console.error("❌ Stats page returned login page — credentials/cookie wrong!");
            STATE.cookie = null;
            STATE.sessKey = null;
            return;
        }

        const key = extractKey(r3.data);
        if (key) {
            STATE.sessKey = key;
            console.log("✅ Login complete! sessKey stored.");
        } else {
            console.error("⚠️ Login may have succeeded but sessKey not found.");
            // Fallback: CDR page try karo
            await tryFetchSessKeyFromCDR();
        }

    } catch (e) {
        console.error("❌ sessKey fetch failed:", e.message);
        throw e;
    }
}

// Fallback: CDR page se sessKey dhundhne ki koshish
async function tryFetchSessKeyFromCDR() {
    try {
        const today = getTodayDate();
        // Pehle CDR page fetch karo without sesskey
        const r = await axios.get(`${BASE_URL}/Agent/SMSCDRReports`, {
            headers: { ...COMMON_HEADERS, "Cookie": STATE.cookie },
            timeout: 15000
        });
        const key = extractKey(r.data);
        if (key) {
            STATE.sessKey = key;
            console.log("✅ sessKey found via CDR page fallback.");
        }
    } catch(e) {
        console.error("❌ CDR fallback failed:", e.message);
    }
}

// --- AUTO REFRESH: har 90 seconds ---
setInterval(() => {
    console.log("🔄 Auto refresh login...");
    performLogin().catch(e => console.error("Auto-refresh error:", e.message));
}, 90000);

// --- API ROUTE ---
router.get('/', async (req, res) => {
    const { type } = req.query;

    // Agar session nahi hai toh login karo aur WAIT karo
    if (!STATE.cookie || !STATE.sessKey) {
        console.log("🔄 No session, performing login...");
        try {
            await performLogin();
        } catch(e) {
            return res.status(500).json({ error: "Login failed: " + e.message });
        }

        // Login ke baad bhi nahi mila?
        if (!STATE.cookie || !STATE.sessKey) {
            return res.status(503).json({
                error: "Login failed — check credentials or server availability.",
                debug: {
                    cookie: STATE.cookie ? "present" : "missing",
                    sessKey: STATE.sessKey ? "present" : "missing"
                }
            });
        }
    }

    const ts = Date.now();
    const today = getTodayDate();
    let targetUrl = "", referer = "";

    if (type === 'numbers') {
        referer = `${BASE_URL}/Agent/MySMSNumbers`;
        targetUrl = `${BASE_URL}/Agent/res/data_smsnumbers.php?frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${ts}`;
    } else if (type === 'sms') {
        referer = `${BASE_URL}/Agent/SMSCDRStats`;
        targetUrl = `${BASE_URL}/Agent/res/data_smscdr.php?fdate1=${today}%2000:00:00&fdate2=2099-12-31%2023:59:59&sesskey=${STATE.sessKey}&iDisplayLength=5000&_=${ts}`;
    } else {
        return res.status(400).json({ error: "Invalid type. Use ?type=numbers or ?type=sms" });
    }

    try {
        console.log("📡 Fetching:", targetUrl.substring(0, 100));
        const response = await axios.get(targetUrl, {
            headers: {
                ...COMMON_HEADERS,
                "Cookie": STATE.cookie,
                "Referer": referer
            },
            timeout: 20000
        });

        // Session expired check
        if (typeof response.data === 'string' &&
            (response.data.includes('<html') || response.data.toLowerCase().includes('login'))) {
            console.warn("⚠️ Session expired, re-logging in...");
            STATE.cookie = null;
            STATE.sessKey = null;
            try {
                await performLogin();
            } catch(e) {
                return res.status(500).json({ error: "Re-login failed: " + e.message });
            }
            return res.status(503).json({ error: "Session was expired. Please retry request." });
        }

        res.set('Content-Type', 'application/json');
        res.send(response.data);

    } catch (e) {
        if (e.response?.status === 403) {
            STATE.cookie = null;
            STATE.sessKey = null;
            performLogin().catch(() => {});
            return res.status(403).json({ error: "403 Forbidden — session reset, retry in 5 seconds." });
        }
        console.error("❌ Fetch error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- EXPORT ---
module.exports = router;

// --- INITIAL LOGIN (startup pe) ---
performLogin().catch(e => console.error("Initial login error:", e.message));
