const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION ---
const CREDENTIALS = {
    username: "Kami526",
    password: "Kami526"
};

const BASE_URL    = "http://51.89.7.175/sms";
const CAPTCHA_URL = `${BASE_URL}/captcha.php`;
const SIGNIN_URL  = `${BASE_URL}/signmein`;
const STATS_URL   = `${BASE_URL}/client/`;

const COMMON_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36",
    "Accept-Language": "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
    "X-Requested-With": "mark.via.gp"
};

// --- GLOBAL STATE ---
let STATE = {
    cookie:       null,
    loginPromise: null
};

// --- HELPERS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// --- SOLVE IMAGE CAPTCHA (Auto-detect: ocr.space → Claude API → 2captcha) ---
async function solveCaptcha(cookie) {
    // Fetch captcha image
    const rand = Math.random().toString(36).substring(2, 8);
    const imgResponse = await axios.get(`${CAPTCHA_URL}?rand=${rand}`, {
        headers: {
            ...COMMON_HEADERS,
            "Cookie":  cookie,
            "Referer": `${BASE_URL}/SignIn`,
            "Accept":  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        },
        responseType: "arraybuffer",
        timeout: 15000
    });

    const base64Image = Buffer.from(imgResponse.data).toString('base64');
    const contentType = imgResponse.headers['content-type'] || 'image/png';
    console.log(`🖼️ Captcha fetched (${imgResponse.data.byteLength} bytes)`);

    // ── METHOD 1: ocr.space FREE API (no install needed, just HTTP) ──────────
    try {
        console.log("🔍 Trying ocr.space API...");
        const formData = new URLSearchParams();
        formData.append('apikey',       process.env.OCR_SPACE_KEY || 'K81598983888957');
        formData.append('base64Image',  `data:${contentType};base64,${base64Image}`);
        formData.append('language',     'eng');
        formData.append('isOverlayRequired', 'false');
        formData.append('OCREngine',    '2');  // Engine 2 better for captchas
        formData.append('scale',        'true');
        formData.append('isTable',      'false');

        const ocrRes = await axios.post(
            'https://api.ocr.space/parse/image',
            formData.toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 20000
            }
        );

        const parsed = ocrRes.data;
        if (parsed && parsed.ParsedResults && parsed.ParsedResults[0]) {
            const raw = parsed.ParsedResults[0].ParsedText || '';
            const clean = raw.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            console.log(`✅ ocr.space solved: "${clean}" (raw: "${raw.trim()}")`);
            if (clean.length >= 3) return clean;
            throw new Error("Too short: " + clean);
        }
        throw new Error("No result from ocr.space: " + JSON.stringify(parsed));
    } catch(e) {
        console.warn("⚠️ ocr.space failed:", e.message);
    }

    // ── METHOD 2: Claude Vision API (if ANTHROPIC_API_KEY set) ───────────────
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (ANTHROPIC_KEY) {
        try {
            console.log("🤖 Trying Claude Vision API...");
            const claudeRes = await axios.post(
                "https://api.anthropic.com/v1/messages",
                {
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 50,
                    messages: [{
                        role: "user",
                        content: [
                            {
                                type: "image",
                                source: { type: "base64", media_type: contentType, data: base64Image }
                            },
                            {
                                type: "text",
                                text: "CAPTCHA image. Reply with ONLY the characters shown — no spaces, no explanation. Usually 5 uppercase letters/digits."
                            }
                        ]
                    }]
                },
                {
                    headers: {
                        "Content-Type":      "application/json",
                        "x-api-key":         ANTHROPIC_KEY,
                        "anthropic-version": "2023-06-01"
                    },
                    timeout: 20000
                }
            );
            const text = claudeRes.data.content[0].text.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            console.log(`✅ Claude Vision solved: "${text}"`);
            if (text.length >= 3) return text;
        } catch(e) {
            console.warn("⚠️ Claude Vision failed:", e.message);
        }
    }

    // ── METHOD 3: Tesseract.js (if installed) ────────────────────────────────
    try {
        const Tesseract = require('tesseract.js');
        const { data: { text } } = await Tesseract.recognize(
            Buffer.from(base64Image, 'base64'), 'eng',
            { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: '8' }
        );
        const clean = text.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        console.log(`✅ Tesseract solved: "${clean}"`);
        if (clean.length >= 3) return clean;
    } catch(e) {
        if (e.code !== 'MODULE_NOT_FOUND') console.warn("⚠️ Tesseract failed:", e.message);
    }

    // ── METHOD 4: 2captcha.com (if TWO_CAPTCHA_KEY set) ──────────────────────
    const TWO_CAPTCHA_KEY = process.env.TWO_CAPTCHA_KEY;
    if (TWO_CAPTCHA_KEY) {
        try {
            console.log("💰 Trying 2captcha.com...");
            const submitRes = await axios.post(
                'http://2captcha.com/in.php',
                `key=${TWO_CAPTCHA_KEY}&method=base64&body=${encodeURIComponent(base64Image)}&json=1`,
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
            );
            const captchaId = submitRes.data.request;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 3000));
                const result = await axios.get(
                    `http://2captcha.com/res.php?key=${TWO_CAPTCHA_KEY}&action=get&id=${captchaId}&json=1`,
                    { timeout: 10000 }
                );
                if (result.data.status === 1) {
                    const solved = result.data.request.trim().toUpperCase();
                    console.log(`✅ 2captcha solved: "${solved}"`);
                    return solved;
                }
            }
        } catch(e) {
            console.warn("⚠️ 2captcha failed:", e.message);
        }
    }

    throw new Error("All captcha methods failed. ocr.space unavailable — set OCR_SPACE_KEY, ANTHROPIC_API_KEY, or TWO_CAPTCHA_KEY env variable.");
}

// --- CORE LOGIN ---
function performLogin() {
    if (STATE.loginPromise) {
        console.log("⏳ Login already in progress, waiting...");
        return STATE.loginPromise;
    }

    STATE.loginPromise = _doLogin().finally(() => {
        STATE.loginPromise = null;
    });

    return STATE.loginPromise;
}

async function _doLogin() {
    console.log("🔐 Starting Kami526 login...");

    // Step 1: GET SignIn page — grab session cookie
    const r1 = await axios.get(`${BASE_URL}/SignIn`, {
        headers: {
            ...COMMON_HEADERS,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Cache-Control": "max-age=0",
            "Upgrade-Insecure-Requests": "1"
        },
        timeout: 15000
    });

    let tempCookie = "";
    if (r1.headers['set-cookie']) {
        const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
        if (c) tempCookie = c.split(';')[0];
    }
    console.log("🍪 Session cookie:", tempCookie || "(none yet)");

    // Step 2: Solve image captcha (retry up to 3 times)
    let captchaText = "";
    let loginSuccess = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`🔄 Login attempt ${attempt}/3`);

        try {
            captchaText = await solveCaptcha(tempCookie);
        } catch(e) {
            console.error(`❌ Captcha attempt ${attempt} failed:`, e.message);
            if (attempt === 3) throw e;
            continue;
        }

        // Step 3: POST signin
        const r2 = await axios.post(
            SIGNIN_URL,
            new URLSearchParams({
                username: CREDENTIALS.username,
                password: CREDENTIALS.password,
                capt:     captchaText
            }),
            {
                headers: {
                    ...COMMON_HEADERS,
                    "Content-Type":           "application/x-www-form-urlencoded",
                    "Cookie":                 tempCookie,
                    "Referer":                `${BASE_URL}/SignIn`,
                    "Origin":                 "http://51.89.7.175",
                    "Accept":                 "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Upgrade-Insecure-Requests": "1"
                },
                maxRedirects: 0,
                validateStatus: () => true,
                timeout: 15000
            }
        );

        console.log(`📬 Signin status: ${r2.status}`);

        // Update cookie if new one provided
        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (newC) tempCookie = newC.split(';')[0];
        }

        // Check if redirected to client dashboard (success)
        const location = r2.headers['location'] || '';
        if (r2.status === 302 && (location.includes('/client') || location.includes('client/'))) {
            STATE.cookie = tempCookie;
            loginSuccess = true;
            console.log(`✅ Login successful! Redirected to: ${location}`);
            break;
        }

        // Check response body for error
        const body = r2.data || '';
        if (typeof body === 'string' && body.toLowerCase().includes('invalid')) {
            console.warn(`⚠️ Attempt ${attempt}: Invalid captcha or credentials. Retrying...`);
            continue;
        }

        // If 200 and no error — assume success
        if (r2.status === 200 || r2.status === 302) {
            STATE.cookie = tempCookie;
            loginSuccess = true;
            console.log("✅ Login assumed successful.");
            break;
        }
    }

    if (!loginSuccess) {
        throw new Error("Login failed after 3 attempts (bad captcha or credentials)");
    }

    console.log(`🍪 Final cookie: ${STATE.cookie}`);
}

// --- AUTO REFRESH every 90 seconds ---
setInterval(() => {
    console.log("🔄 Auto-refreshing Kami526 session...");
    performLogin().catch(e => console.error("Auto-refresh error:", e.message));
}, 90000);

// --- API ROUTE ---
router.get('/', async (req, res) => {
    const { type } = req.query;

    if (!STATE.cookie) {
        console.log("🔄 No session, logging in...");
        try {
            await performLogin();
        } catch(e) {
            return res.status(500).json({ error: "Login failed: " + e.message });
        }

        if (!STATE.cookie) {
            return res.status(503).json({
                error: "Login failed — check credentials or captcha.",
                debug: { cookie: STATE.cookie ? "present" : "missing" }
            });
        }
    }

    const ts    = Date.now();
    const today = getTodayDate();
    let targetUrl = "", referer = "";

    if (type === 'numbers') {
        referer   = `${BASE_URL}/client/Numbers`;
        targetUrl = `${BASE_URL}/client/ajax/dt_numbers.php`
            + `?ftermination=&fclient=`
            + `&sEcho=2`
            + `&iColumns=8`
            + `&sColumns=%2C%2C%2C%2C%2C%2C%2C`
            + `&iDisplayStart=0&iDisplayLength=5000`
            + `&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=false&bSortable_0=false`
            + `&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true`
            + `&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true`
            + `&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true`
            + `&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true`
            + `&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true`
            + `&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true`
            + `&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true`
            + `&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=asc&iSortingCols=1`
            + `&_=${ts}`;

    } else if (type === 'sms') {
        referer   = `${BASE_URL}/client/Reports`;
        targetUrl = `${BASE_URL}/client/ajax/dt_reports.php`
            + `?fdate1=${today}%2000:00:00&fdate2=2199-12-31%2023:59:59`
            + `&ftermination=&fclient=&fnum=&fcli=`
            + `&fgdate=0&fgtermination=0&fgclient=0&fgnumber=0&fgcli=0&fg=0`
            + `&sEcho=1`
            + `&iColumns=11`
            + `&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C%2C%2C`
            + `&iDisplayStart=0&iDisplayLength=5000`
            + `&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true`
            + `&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true`
            + `&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true`
            + `&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true`
            + `&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true`
            + `&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true`
            + `&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true`
            + `&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true`
            + `&mDataProp_8=8&sSearch_8=&bRegex_8=false&bSearchable_8=true&bSortable_8=true`
            + `&mDataProp_9=9&sSearch_9=&bRegex_9=false&bSearchable_9=true&bSortable_9=true`
            + `&mDataProp_10=10&sSearch_10=&bRegex_10=false&bSearchable_10=true&bSortable_10=true`
            + `&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1`
            + `&_=${ts}`;

    } else {
        return res.status(400).json({ error: "Invalid type. Use ?type=numbers or ?type=sms" });
    }

    try {
        console.log("📡 Fetching:", targetUrl.substring(0, 120));
        const response = await axios.get(targetUrl, {
            headers: {
                ...COMMON_HEADERS,
                "Cookie":           STATE.cookie,
                "Referer":          referer,
                "Accept":           "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest"
            },
            timeout: 20000
        });

        // Session expired check
        if (typeof response.data === 'string' &&
            (response.data.includes('<html') || response.data.toLowerCase().includes('signin'))) {
            console.warn("⚠️ Session expired, re-logging in...");
            STATE.cookie = null;
            try {
                await performLogin();
            } catch(e) {
                return res.status(500).json({ error: "Re-login failed: " + e.message });
            }
            return res.status(503).json({ error: "Session expired. Please retry." });
        }

        let result = typeof response.data === 'string'
            ? JSON.parse(response.data)
            : response.data;

        if (type === 'numbers') result = fixNumbers(result);
        if (type === 'sms')     result = fixSMS(result);

        res.json(result);

    } catch (e) {
        if (e.response?.status === 403) {
            STATE.cookie = null;
            performLogin().catch(() => {});
            return res.status(403).json({ error: "403 Forbidden — session reset, retry in 5s." });
        }
        console.error("❌ Fetch error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
    if (!data.aaData) return data;

    data.aaData = data.aaData.map(row => [
        row[1],
        "",
        row[3],
        "Weekly",
        (row[4] || "").replace(/<[^>]+>/g, "").trim(),
        (row[7] || "").replace(/<[^>]+>/g, "").trim()
    ]);

    return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
    if (!data.aaData) return data;

    data.aaData = data.aaData
        .map(row => {
            let message = (row[5] || "")
                .replace(/legendhacker/gi, "")
                .trim();

            if (!message) return null;

            return [
                row[0],  // date
                row[1],  // range
                row[2],  // number
                row[3],  // service
                message, // OTP message
                "$",
                row[7] || 0
            ];
        })
        .filter(Boolean);

    return data;
}

// --- EXPORT ---
module.exports = router;

// --- INITIAL LOGIN ---
performLogin().catch(e => console.error("Initial login error:", e.message));
