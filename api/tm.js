const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const CREDENTIALS = { username: "Kami526", password: "Kami526" };
const BASE_URL    = "http://51.89.7.175/sms";

const HEADERS = {
    "User-Agent":       "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36",
    "Accept-Language":  "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
    "X-Requested-With": "mark.via.gp"
};

let STATE = { cookie: null, loginPromise: null };

function getToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// --- IMAGE CAPTCHA SOLVER (ocr.space free) ---
async function solveCaptcha(cookie) {
    const rand = Math.random().toString(36).substring(2, 8);
    const imgResp = await axios.get(`${BASE_URL}/captcha.php?rand=${rand}`, {
        headers: { ...HEADERS, "Cookie": cookie, "Referer": `${BASE_URL}/SignIn`, "Accept": "image/*,*/*" },
        responseType: "arraybuffer",
        timeout: 15000
    });

    const base64 = Buffer.from(imgResp.data).toString("base64");
    const mime   = imgResp.headers["content-type"] || "image/png";
    console.log(`🖼️ [Kami] Captcha fetched (${imgResp.data.byteLength} bytes)`);

    const form = new URLSearchParams();
    form.append("apikey",           "helloworld");
    form.append("base64Image",      `data:${mime};base64,${base64}`);
    form.append("language",         "eng");
    form.append("isOverlayRequired","false");
    form.append("OCREngine",        "2");
    form.append("scale",            "true");
    form.append("isTable",          "false");

    const ocrResp = await axios.post("https://api.ocr.space/parse/image", form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 25000
    });

    const parsed = ocrResp.data;
    if (!parsed?.ParsedResults?.[0])
        throw new Error("ocr.space no result: " + JSON.stringify(parsed));

    const raw   = parsed.ParsedResults[0].ParsedText || "";
    const clean = raw.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    console.log(`🔑 [Kami] Captcha: "${clean}" (raw: "${raw.trim()}")`);

    if (clean.length < 3) throw new Error("Captcha too short: " + clean);
    return clean;
}

// --- LOGIN ---
function performLogin() {
    if (STATE.loginPromise) return STATE.loginPromise;
    STATE.loginPromise = _doLogin().finally(() => { STATE.loginPromise = null; });
    return STATE.loginPromise;
}

async function _doLogin() {
    console.log("🔐 [Kami] Logging in...");

    const r1 = await axios.get(`${BASE_URL}/SignIn`, {
        headers: { ...HEADERS, "Accept": "text/html,*/*", "Cache-Control": "max-age=0" },
        timeout: 15000
    });

    let cookie = "";
    if (r1.headers["set-cookie"]) {
        const c = r1.headers["set-cookie"].find(x => x.includes("PHPSESSID"));
        if (c) cookie = c.split(";")[0];
    }
    console.log(`🍪 [Kami] Cookie: ${cookie}`);

    // Retry up to 5 times with fresh captcha each time
    for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`🔄 [Kami] Attempt ${attempt}/5`);

        let captchaText;
        try {
            captchaText = await solveCaptcha(cookie);
        } catch(e) {
            console.warn(`⚠️ [Kami] Captcha error: ${e.message}`);
            if (attempt === 5) throw new Error("Captcha failed: " + e.message);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        const r2 = await axios.post(`${BASE_URL}/signmein`,
            new URLSearchParams({ username: CREDENTIALS.username, password: CREDENTIALS.password, capt: captchaText }),
            {
                headers: {
                    ...HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie":       cookie,
                    "Referer":      `${BASE_URL}/SignIn`,
                    "Origin":       "http://51.89.7.175",
                    "Accept":       "text/html,*/*"
                },
                maxRedirects: 0, validateStatus: () => true, timeout: 15000
            }
        );

        console.log(`📬 [Kami] Status: ${r2.status} | Location: ${r2.headers["location"] || "none"}`);

        if (r2.headers["set-cookie"]) {
            const c = r2.headers["set-cookie"].find(x => x.includes("PHPSESSID"));
            if (c) cookie = c.split(";")[0];
        }

        const location = r2.headers["location"] || "";
        const body     = typeof r2.data === "string" ? r2.data.toLowerCase() : "";

        if ((r2.status === 302 || r2.status === 301) && location.includes("client")) {
            STATE.cookie = cookie;
            console.log("✅ [Kami] Login OK!");
            return;
        }

        if (r2.status === 200 && !body.includes("invalid") && !body.includes("wrong") && !body.includes("signi")) {
            STATE.cookie = cookie;
            console.log("✅ [Kami] Login OK (200)!");
            return;
        }

        if (r2.status === 302 || r2.status === 301) {
            STATE.cookie = cookie;
            console.log("✅ [Kami] Login redirect — OK.");
            return;
        }

        console.warn(`⚠️ [Kami] Wrong captcha/creds, retrying...`);
        await new Promise(r => setTimeout(r, 500));
    }

    throw new Error("Login failed after 5 attempts");
}

setInterval(() => performLogin().catch(e => console.error("[Kami] Refresh:", e.message)), 90000);

// --- ROUTE ---
router.get("/", async (req, res) => {
    const { type } = req.query;

    if (!STATE.cookie) {
        try { await performLogin(); } catch(e) { return res.status(500).json({ error: "Login failed: " + e.message }); }
        if (!STATE.cookie) return res.status(503).json({ error: "Login failed after retries" });
    }

    const ts = Date.now(), today = getToday();
    let url = "", referer = "";

    if (type === "numbers") {
        referer = `${BASE_URL}/client/Numbers`;
        url = `${BASE_URL}/client/ajax/dt_numbers.php?ftermination=&fclient=&sEcho=2&iColumns=8&sColumns=%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=false&bSortable_0=false&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=asc&iSortingCols=1&_=${ts}`;
    } else if (type === "sms") {
        referer = `${BASE_URL}/client/Reports`;
        url = `${BASE_URL}/client/ajax/dt_reports.php?fdate1=${today}%2000:00:00&fdate2=2199-12-31%2023:59:59&ftermination=&fclient=&fnum=&fcli=&fgdate=0&fgtermination=0&fgclient=0&fgnumber=0&fgcli=0&fg=0&sEcho=1&iColumns=11&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&mDataProp_8=8&sSearch_8=&bRegex_8=false&bSearchable_8=true&bSortable_8=true&mDataProp_9=9&sSearch_9=&bRegex_9=false&bSearchable_9=true&bSortable_9=true&mDataProp_10=10&sSearch_10=&bRegex_10=false&bSearchable_10=true&bSortable_10=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
    } else {
        return res.status(400).json({ error: "?type=numbers ya ?type=sms use karo" });
    }

    try {
        const resp = await axios.get(url, {
            headers: { ...HEADERS, "Cookie": STATE.cookie, "Referer": referer, "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
            timeout: 20000
        });

        if (typeof resp.data === "string" && (resp.data.includes("<html") || resp.data.toLowerCase().includes("signin"))) {
            STATE.cookie = null;
            await performLogin().catch(() => {});
            return res.status(503).json({ error: "Session expire — retry karo." });
        }

        let result = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
        if (type === "numbers") result = fixNumbers(result);
        if (type === "sms")     result = fixSMS(result);
        res.json(result);

    } catch(e) {
        if (e.response?.status === 403) { STATE.cookie = null; performLogin().catch(() => {}); }
        res.status(500).json({ error: e.message });
    }
});

function fixNumbers(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => [
        row[1], "", row[3], "Weekly",
        (row[4] || "").replace(/<[^>]+>/g, "").trim(),
        (row[7] || "").replace(/<[^>]+>/g, "").trim()
    ]);
    return data;
}

function fixSMS(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => {
        const msg = (row[5] || "").replace(/legendhacker/gi, "").trim();
        if (!msg) return null;
        return [row[0], row[1], row[2], row[3], msg, "$", row[7] || 0];
    }).filter(Boolean);
    return data;
}

module.exports = router;
performLogin().catch(e => console.error("[Kami] Initial:", e.message));
