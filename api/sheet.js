// Vercel serverless function: server-side proxy for Google Sheets published CSV.
// Avoids CORS issues by fetching from the server instead of the browser.

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQHICtJp0nIwhdHGKwLoPkidVl3MgI-HDxJdNHoaHv3g9SQ6KT4h7O5w0EJcTGwCIK4OFxQmybYpinO/pub?gid=2129032732&single=true&output=csv';

export default async function handler(req, res) {
  try {
    const response = await fetch(SHEET_URL, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NAORUDashboard/1.0)',
        'Accept': 'text/csv, text/plain, */*',
      },
    });

    if (!response.ok) {
      res.status(response.status).send(`HTTP ${response.status} from Google Sheets`);
      return;
    }

    const text = await response.text();
    if (text.trim().startsWith('<')) {
      res.status(502).send('Google returned HTML (sheet not published?)');
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).send(`Fetch failed: ${e.message || e}`);
  }
}
