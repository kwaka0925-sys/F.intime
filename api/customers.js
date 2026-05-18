// Vercel serverless function: proxy for Google Sheets customer list via gviz API.
// Requires the sheet to be shared as "Anyone with the link can view".

const SHEET_ID = '1cpAzEelyxtVRFq2s_E5YBTyZP8BZZJ1egAGqFQEic1g';
const DEFAULT_TAB = '新患管理';

module.exports = async function handler(req, res) {
  let sheetName = DEFAULT_TAB;
  if (req.query && typeof req.query.sheet === 'string' && req.query.sheet) {
    sheetName = req.query.sheet;
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const s = u.searchParams.get('sheet');
      if (s) sheetName = s;
    } catch (_) {}
  }

  const targetUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NAORUDashboard/1.0)',
        'Accept': 'text/csv, text/plain, */*',
      },
    });

    const text = await response.text();

    if (!response.ok) {
      res.statusCode = response.status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Upstream HTTP ${response.status} (sheet="${sheetName}")\n${text.slice(0, 500)}`);
      return;
    }

    if (text.trim().startsWith('<')) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Google returned HTML — sheet might not exist or share permission is missing.\nTab: ${sheetName}\n${text.slice(0, 500)}`);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Fetch failed: ${e && e.message ? e.message : String(e)}`);
  }
};
