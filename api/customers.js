// Vercel serverless function: proxy for Google Sheets customer list (published CSV).
// Supports per-clinic sheets via ?clinic=nakamozu|tenrokuten

const CUSTOMERS_CSV_URLS = {
  nakamozu:   'https://docs.google.com/spreadsheets/d/e/2PACX-1vRxyoaXP_WFidQ3NEjNA7Sb9MhYJwrhxm4UCBPQzfrjXNQ5KAU-IZ_UnEu1VgEFCGZXwuneA2OtxIWA/pub?gid=2085123402&single=true&output=csv',
  tenrokuten: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ7VDPUBlJ1En2sEFnA1QOyW7WzPl9fikJVOo2B6QoRR8cSzpBfTvMfMLEgRCDVz4IJVvwS7v7gCZz9/pub?gid=2085123402&single=true&output=csv',
};

module.exports = async function handler(req, res) {
  let clinic = 'nakamozu';
  if (req.query && typeof req.query.clinic === 'string' && req.query.clinic) {
    clinic = req.query.clinic;
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const c = u.searchParams.get('clinic');
      if (c) clinic = c;
    } catch (_) {}
  }

  const targetUrl = CUSTOMERS_CSV_URLS[clinic];
  if (!targetUrl) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`No customer sheet configured for clinic: ${clinic}`);
    return;
  }

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
      res.end(`Upstream HTTP ${response.status}\n${text.slice(0, 500)}`);
      return;
    }

    if (text.trim().startsWith('<')) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Google returned HTML — sheet might not be published as CSV.\n${text.slice(0, 500)}`);
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
