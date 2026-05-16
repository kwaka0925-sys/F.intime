// Vercel serverless function: server-side proxy for Google Sheets via gviz CSV API.
// Accepts ?clinic=nakamozu|tenrokuten to pick the sheet, and optional ?sheet=日報 YYYYMM
// to pick a specific tab. Defaults to current month's tab.
//
// Requires the sheet to be shared as "Anyone with the link can view".

const SHEET_IDS = {
  nakamozu:   '1Y_2shrIM14a3KhaPpwNkAhwJCHsjq6l4Cn7Yt9N3kb4',
  tenrokuten: '',
};

function buildGvizUrl(sheetId, sheetName) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

function currentMonthTabName() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `日報 ${ym}`;
}

module.exports = async function handler(req, res) {
  let clinic = 'nakamozu';
  let sheetName = '';
  if (req.query) {
    if (typeof req.query.clinic === 'string' && req.query.clinic) clinic = req.query.clinic;
    if (typeof req.query.sheet === 'string' && req.query.sheet) sheetName = req.query.sheet;
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const c = u.searchParams.get('clinic'); if (c) clinic = c;
      const s = u.searchParams.get('sheet'); if (s) sheetName = s;
    } catch (_) {}
  }

  const sheetId = SHEET_IDS[clinic];
  if (!sheetId) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`No sheet configured for clinic: ${clinic}`);
    return;
  }

  if (!sheetName) sheetName = currentMonthTabName();
  const targetUrl = buildGvizUrl(sheetId, sheetName);

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
