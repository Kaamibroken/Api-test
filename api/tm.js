const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION (Agent) ---
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
    isLoggingIn: false
};

// --- HELPER FUNCTIONS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function extractKey(html) {
    let match = html.match(/sesskey=([^&"']+)/);
    if (match) return match[1];
    match = html.match(/sesskey\s*[:=]\s*["']([^"']+)["']/);
    if (match) return match[1];
    return null;
}

// --- LOGIN & FETCH COOKIE + SESSKEY ---
async function performLogin() {
    if (STATE.isLoggingIn) return;
    STATE.isLoggingIn = true;

    try {
        const instance = axios.create({ headers: COMMON_HEADERS, timeout: 15000, withCredentials:true });
        const r1 = await instance.get(`${BASE_URL}/login`);

        let tempCookie = "";
        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) tempCookie = c.split(';')[0];
        }

        const match = r1.data.match(/What is (\d+) \+ (\d+) = \?/);
        const ans = match ? parseInt(match[1])+parseInt(match[2]) : 0;

        const r2 = await instance.post(`${BASE_URL}/signin`, new URLSearchParams({
            username: CREDENTIALS.username,
            password: CREDENTIALS.password,
            capt: ans
        }), {
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": tempCookie, "Referer": `${BASE_URL}/login` },
            maxRedirects:0,
            validateStatus:()=>true
        });

        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            STATE.cookie = newC ? newC.split(';')[0] : tempCookie;
        } else {
            STATE.cookie = tempCookie;
        }

        const r3 = await axios.get(STATS_PAGE_URL, { headers:{ ...COMMON_HEADERS, "Cookie": STATE.cookie, "Referer": `${BASE_URL}/Agent/SMSDashboard` } });
        const key = extractKey(r3.data);
        if (key) STATE.sessKey = key;

    } catch(e) {
        console.error("❌ MSI login failed:", e.message);
    } finally {
        STATE.isLoggingIn = false;
    }
}

// --- AUTO REFRESH LOGIN EVERY 2 MINUTES ---
setInterval(() => performLogin(), 120000);

// --- API ROUTE ---
router.get('/', async (req,res)=>{
    const { type } = req.query;
    if (!STATE.cookie || !STATE.sessKey) {
        await performLogin();
        if (!STATE.sessKey) return res.status(500).json({ error:"Waiting for login..." });
    }

    const ts = Date.now();
    const today = getTodayDate();
    let targetUrl = "", referer="";

    if(type==='numbers') {
        referer = `${BASE_URL}/Agent/MySMSNumbers`;
        targetUrl = `${BASE_URL}/Agent/res/data_smsnumbers.php?frange=&fclient=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${ts}`;
    } else if(type==='sms') {
        referer = `${BASE_URL}/Agent/SMSCDRStats`;
        targetUrl = `${BASE_URL}/Agent/res/data_smscdr.php?fdate1=${today}%2000:00:00&fdate2=2099-12-31%2023:59:59&sesskey=${STATE.sessKey}&iDisplayLength=5000&_=${ts}`;
    } else {
        return res.status(400).json({ error:"Invalid type. Use ?type=numbers or ?type=sms" });
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: { ...COMMON_HEADERS, "Cookie": STATE.cookie, "Referer": referer }
        });

        if(typeof response.data === 'string' && (response.data.includes('<html') || response.data.includes('login'))) {
            STATE.cookie = null;
            STATE.sessKey = null;
            await performLogin();
            return res.status(503).send("Session refreshed. Try again.");
        }

        res.set('Content-Type','application/json');
        res.send(response.data);

    } catch(e) {
        if(e.response && e.response.status===403){
            STATE.cookie=null; STATE.sessKey=null;
            await performLogin();
            return res.redirect(req.originalUrl);
        }
        res.status(500).json({ error:e.message });
    }
});

// --- EXPORT ROUTER ---
module.exports = router;

// --- INITIAL LOGIN ---
performLogin();
