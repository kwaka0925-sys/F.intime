// Vercel serverless function: server-side proxy for Google Sheets published CSVs.
// Accepts ?clinic=nakamozu|tenrokuten to pick the right sheet(s) per clinic.
// 各クリニックは複数のCSV URL（月別タブ等）を持てる。サーバー側で全部取得→
// ヘッダー1行＋各シートのデータ行をマージした単一のCSVを返す。

const SHEET_URLS = {
  nakamozu: [
    // 2025年9月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=726457200&single=true&output=csv',
    // 2025年10月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=182539070&single=true&output=csv',
    // 2025年11月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=2049917737&single=true&output=csv',
    // 2025年12月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=743410317&single=true&output=csv',
    // 2026年1月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=449418594&single=true&output=csv',
    // 2026年2月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=695195883&single=true&output=csv',
    // 2026年3月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=1610546607&single=true&output=csv',
    // 2026年4月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRrzMfcwpJEqsKurlA5ht_fuC9Qd-D74CZoUVRmhZuXdZRmcIdJQ_dL2cO_haMRKAG_3loI46XYBIEo/pub?gid=2050100492&single=true&output=csv',
    // 2026年5月
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRxyoaXP_WFidQ3NEjNA7Sb9MhYJwrhxm4UCBPQzfrjXNQ5KAU-IZ_UnEu1VgEFCGZXwuneA2OtxIWA/pub?gid=2129032732&single=true&output=csv',
  ],
  tenrokuten: [
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ7VDPUBlJ1En2sEFnA1QOyW7WzPl9fikJVOo2B6QoRR8cSzpBfTvMfMLEgRCDVz4IJVvwS7v7gCZz9/pub?gid=726457200&single=true&output=csv',
  ],
};

function normalize(text) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
}

function mergeCsvTexts(texts) {
  const cleaned = texts.map(normalize).filter(t => t.length > 0);
  if (cleaned.length === 0) return '';
  const parts = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    const nl = cleaned[i].indexOf('\n');
    if (nl < 0) continue; // header only, skip
    const rest = cleaned[i].slice(nl + 1);
    if (rest) parts.push(rest);
  }
  return parts.join('\n') + '\n';
}

async function fetchOne(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NAORUDashboard/1.0)',
      'Accept': 'text/csv, text/plain, */*',
    },
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

module.exports = async function handler(req, res) {
  // Determine which clinic to fetch
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

  const raw = SHEET_URLS[clinic];
  const urls = Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : []);
  if (urls.length === 0) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`No sheet configured for clinic: ${clinic}`);
    return;
  }

  try {
    const results = await Promise.all(urls.map(u => fetchOne(u).catch(e => ({ ok: false, status: 0, text: String(e && e.message || e) }))));

    const failures = [];
    results.forEach((r, i) => {
      if (!r.ok) {
        failures.push(`#${i + 1} HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
      } else if ((r.text || '').trim().startsWith('<')) {
        failures.push(`#${i + 1} Google returned HTML (sheet not published?): ${(r.text || '').slice(0, 200)}`);
      }
    });

    if (failures.length > 0) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Upstream failures (${failures.length}/${urls.length}):\n` + failures.join('\n'));
      return;
    }

    const merged = mergeCsvTexts(results.map(r => r.text));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Sheets-Merged', String(urls.length));
    res.end(merged);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Fetch failed: ${e && e.message ? e.message : String(e)}`);
  }
};
