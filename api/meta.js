// Vercel serverless function: server-side proxy for the Meta Ads published CSV.

const META_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRw7Nv-6tfm67kZF9KbgN9PeRiQ6Ixp_xHnrHkCNAc_xaL_-EHGFaRu7iioIU6bfHvYQDWVezHJMVz2/pub?gid=1879287427&single=true&output=csv';

module.exports = async function handler(req, res) {
  try {
    const response = await fetch(META_URL, {
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
      res.end(`Google returned HTML (sheet not published?)\n${text.slice(0, 500)}`);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Fetch failed: ${e && e.message ? e.message : String(e)}`);
  }
};
