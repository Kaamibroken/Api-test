const express = require("express");
const axios   = require("axios");
const router  = express.Router();

const BASE_URL = "http://51.89.7.175/sms";
const COOKIE   = "PHPSESSID=br8hg6on2t8fn3e3lq0o1tn03h";

const HEADERS = {
    "User-Agent":       "Mozilla/5.0 (Linux; Android 13; V2040 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.79 Mobile Safari/537.36",
    "Accept-Language":  "en-PK,en;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6",
    "X-Requested-With": "XMLHttpRequest",
    "Accept":           "application/json, text/javascript, */*; q=0.01"
};

function getToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

router.get("/", async (req, res) => {
    const { type } = req.query;

    const ts = Date.now(), today = getToday();
    let url = "", referer = "";

    if (type === "numbers") {
        referer = `${BASE_URL}/client/Numbers`;
        url = `${BASE_URL}/client/ajax/dt_numbers.php?ftermination=&fclient=&sEcho=2&iColumns=8&sColumns=%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=false&bSortable_0=false&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=asc&iSortingCols=1&_=${ts}`;
    } else if (type === "sms") {
        referer = `${BASE_URL}/client/Reports`;
        url = `${BASE_URL}/client/ajax/dt_reports.php?fdate1=${today}%2000:00:00&fdate2=2199-12-31%2023:59:59&ftermination=&fclient=&fnum=&fcli=&fgdate=0&fgtermination=0&fgclient=0&fgnumber=0&fgcli=0&fg=0&sEcho=1&iColumns=11&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=5000&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&mDataProp_8=8&sSearch_8=&bRegex_8=false&bSearchable_8=true&bSortable_8=true&mDataProp_9=9&sSearch_9=&bRegex_9=false&bSearchable_9=true&bSortable_9=true&mDataProp_10=10&sSearch_10=&bRegex_10=false&bSearchable_10=true&bSortable_10=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
    } else if (type === "raw") {
        referer = `${BASE_URL}/client/Reports`;
        url = `${BASE_URL}/client/ajax/dt_reports.php?fdate1=${today}%2000:00:00&fdate2=2199-12-31%2023:59:59&ftermination=&fclient=&fnum=&fcli=&fgdate=0&fgtermination=0&fgclient=0&fgnumber=0&fgcli=0&fg=0&sEcho=1&iColumns=11&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=3&mDataProp_0=0&mDataProp_1=1&mDataProp_2=2&mDataProp_3=3&mDataProp_4=4&mDataProp_5=5&mDataProp_6=6&mDataProp_7=7&mDataProp_8=8&mDataProp_9=9&mDataProp_10=10&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
        try {
            const resp2 = await axios.get(url, { headers: { ...HEADERS, "Cookie": COOKIE, "Referer": referer }, timeout: 20000 });
            const raw = typeof resp2.data === "string" ? JSON.parse(resp2.data) : resp2.data;
            const labeled = (raw.aaData || []).slice(0, 3).map(row =>
                row.reduce((obj, val, i) => { obj["col_" + i] = val; return obj; }, {})
            );
            return res.json({ total: raw.iTotalRecords, sample: labeled });
        } catch(e) { return res.status(500).json({ error: e.message }); }
    } else {
        return res.status(400).json({ error: "?type=numbers | ?type=sms | ?type=raw" });
    }

    try {
        const resp = await axios.get(url, {
            headers: { ...HEADERS, "Cookie": COOKIE, "Referer": referer },
            timeout: 20000
        });

        if (typeof resp.data === "string" && resp.data.includes("<html")) {
            return res.status(401).json({ error: "Session expire ho gaya — PHPSESSID update karo." });
        }

        let result = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
        if (type === "numbers") result = fixNumbers(result);
        if (type === "sms")     result = fixSMS(result);
        res.json(result);

    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

function fixNumbers(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => [
        row[0],                                            // number name  e.g. "Pakistan070"
        "",
        (row[2] || "").replace(/<[^>]+>/g, "").trim(),    // plan info    e.g. "Monthly45 $ 0.007"
        "Weekly",
        (row[4] || "").replace(/<[^>]+>/g, "").trim(),
        (row[7] || "").replace(/<[^>]+>/g, "").trim()
    ]);
    return data;
}

function fixSMS(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => {
        // row[4] = message (OTP), row[5] = plan name, row[7] = cost
        const msg = (row[4] || row[5] || row[6] || "")
            .replace(/<[^>]+>/g, "")
            .replace(/legendhacker/gi, "")
            .trim();
        if (!msg) return null;
        return [row[0], row[1], row[2], row[3], msg, "$", row[7] || 0];
    }).filter(Boolean);
    return data;
}

module.exports = router;
