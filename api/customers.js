// Vercel serverless function: proxy for Google Sheets customer list via gviz API.
// Requires the sheet to be shared as "Anyone with the link can view".

const SHEET_ID = '1cpAzEelyxtVRFq2s_E5YBTyZP8BZZJ1egAGqFQEic1g';
const DEFAULT_GID = '2085123402'; // 最新ご指定のタブ
const DEFAULT_TAB = '顧客情報';

module.exports = async function handler(req, res) {
  let gid = DEFAULT_GID;
  let sheetName = '';
  if (req.query) {
    if (typeof req.query.gid === 'string' && req.query.gid) gid = req.query.gid;
    if (typeof req.query.sheet === 'string' && req.query.sheet) sheetName = req.query.sheet;
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const g = u.searchParams.get('gid'); if (g) gid = g;
      const s = u.searchParams.get('sheet'); if (s) sheetName = s;
    } catch (_) {}
  }

  // gid 指定がある場合は gid で取得（タブ名変更に強い）
  const targetUrl = sheetName
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;

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
      res.end(`Upstream HTTP ${response.status} (sheet="${sheetName || 'gid:'+gid}")\n${text.slice(0, 500)}`);
      return;
    }

    if (text.trim().startsWith('<')) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Google returned HTML — sheet might not exist or share permission is missing.\nTab: ${sheetName || 'gid:'+gid}\n${text.slice(0, 500)}`);
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
