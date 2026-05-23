// Vercel serverless function: Square API proxy for f.intime.
//
// Supports multi-location (中百舌鳥院 / 天満天六院) — each clinic has its own
// access token + Location ID, configured via environment variables:
//
//   SQUARE_TOKEN_NAKAMOZU    SQUARE_LOCATION_NAKAMOZU
//   SQUARE_TOKEN_TENROKU     SQUARE_LOCATION_TENROKU
//
// Endpoints:
//   GET /api/square?action=status         → { connectedClinics: ['nakamozu','tenrokuten'], missing: [] }
//   GET /api/square?action=sync&from=YYYY-MM-DD&to=YYYY-MM-DD
//                                          → { sales: [...], connectedClinics: [...], errors: [...] }

const SQUARE_API_BASE = 'https://connect.squareup.com';
const SQUARE_API_VERSION = '2024-10-17';

const CLINIC_CONFIG = [
  { clinic: 'nakamozu',   tokenEnv: 'SQUARE_TOKEN_NAKAMOZU', locationEnv: 'SQUARE_LOCATION_NAKAMOZU' },
  { clinic: 'tenrokuten', tokenEnv: 'SQUARE_TOKEN_TENROKU',  locationEnv: 'SQUARE_LOCATION_TENROKU'  },
];

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url, 'http://localhost');
    const q = {};
    for (const [k, v] of u.searchParams) q[k] = v;
    return q;
  } catch (_) {
    return {};
  }
}

function resolveClinics() {
  return CLINIC_CONFIG.map(c => ({
    clinic: c.clinic,
    token: process.env[c.tokenEnv] || '',
    locationId: process.env[c.locationEnv] || '',
    configured: !!(process.env[c.tokenEnv] && process.env[c.locationEnv]),
  }));
}

function defaultMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = n => String(n).padStart(2, '0');
  const from = `${y}-${pad(m + 1)}-01`;
  const to = `${y}-${pad(m + 1)}-${pad(now.getDate())}`;
  return { from, to };
}

function toRFC3339(dateStr, endOfDay) {
  // Treat the date as JST (UTC+9). f.intime is Japan-only.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const suffix = endOfDay ? 'T23:59:59+09:00' : 'T00:00:00+09:00';
  return `${dateStr}${suffix}`;
}

async function squareFetch(path, token, init = {}) {
  const res = await fetch(`${SQUARE_API_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const msg = json && json.errors ? json.errors.map(e => `${e.code}: ${e.detail}`).join(' / ') : text.slice(0, 300);
    throw new Error(`Square API ${res.status}: ${msg}`);
  }
  return json || {};
}

async function fetchOrders(token, locationId, beginRfc, endRfc) {
  const orders = [];
  let cursor = undefined;
  for (let i = 0; i < 50; i++) { // hard cap to avoid runaway
    const body = {
      location_ids: [locationId],
      cursor,
      limit: 500,
      query: {
        filter: {
          date_time_filter: { closed_at: { start_at: beginRfc, end_at: endRfc } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
      },
    };
    const data = await squareFetch('/v2/orders/search', token, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (Array.isArray(data.orders)) orders.push(...data.orders);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return orders;
}

async function fetchPayments(token, locationId, beginRfc, endRfc) {
  const payments = [];
  let cursor = undefined;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({
      begin_time: beginRfc,
      end_time: endRfc,
      location_id: locationId,
      limit: '100',
      sort_order: 'ASC',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await squareFetch(`/v2/payments?${params.toString()}`, token);
    if (Array.isArray(data.payments)) payments.push(...data.payments);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return payments;
}

function formatJstDateTime(rfc) {
  if (!rfc) return { date: '', time: '' };
  const d = new Date(rfc);
  if (isNaN(d.getTime())) return { date: '', time: '' };
  // Convert to JST
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const date = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
  const time = `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  return { date, time };
}

function moneyToYen(money) {
  if (!money || typeof money.amount !== 'number') return 0;
  // Square JPY amounts are already in minor units == yen (no decimal currency).
  return money.amount;
}

function sumProcessingFee(payment) {
  if (!payment || !Array.isArray(payment.processing_fee)) return 0;
  return payment.processing_fee.reduce((s, f) => s + moneyToYen(f.amount_money), 0);
}

function buildSalesForClinic(clinic, orders, payments) {
  const ordersById = new Map();
  for (const o of orders) ordersById.set(o.id, o);

  const sales = [];

  // Prefer iterating payments — they always carry processing_fee and a stable transactionId.
  const seenOrderIds = new Set();
  for (const p of payments) {
    if (p.status && p.status !== 'COMPLETED' && p.status !== 'APPROVED') continue;
    const order = p.order_id ? ordersById.get(p.order_id) : null;
    if (order) seenOrderIds.add(order.id);

    const created = p.created_at || (order && order.closed_at) || (order && order.created_at);
    const { date, time } = formatJstDateTime(created);

    const netFromOrder = order ? moneyToYen(order.net_amount_due_money || order.total_money) : null;
    const grossFromOrder = order ? moneyToYen(order.total_money) : null;
    const amount = netFromOrder != null ? netFromOrder : moneyToYen(p.amount_money);
    const grossAmount = grossFromOrder != null ? grossFromOrder : moneyToYen(p.total_money || p.amount_money);
    const tax = order ? moneyToYen(order.total_tax_money) : 0;

    const itemNames = order && Array.isArray(order.line_items)
      ? order.line_items.map(li => li.name).filter(Boolean).join(' / ')
      : '';

    sales.push({
      date,
      time,
      amount,
      grossAmount,
      fee: sumProcessingFee(p),
      tax,
      menu: itemNames,
      staff: '',
      customer: '',
      location: '',
      clinic,
      transactionId: p.id,
      paymentMethod: (p.card_details && p.card_details.card && p.card_details.card.card_brand) || p.source_type || '',
      source: 'Square API',
    });
  }

  // Edge case: orders without a payment record (cash-only via Square POS, etc.)
  for (const o of orders) {
    if (seenOrderIds.has(o.id)) continue;
    const { date, time } = formatJstDateTime(o.closed_at || o.created_at);
    sales.push({
      date,
      time,
      amount: moneyToYen(o.net_amount_due_money || o.total_money),
      grossAmount: moneyToYen(o.total_money),
      fee: 0,
      tax: moneyToYen(o.total_tax_money),
      menu: Array.isArray(o.line_items) ? o.line_items.map(li => li.name).filter(Boolean).join(' / ') : '',
      staff: '',
      customer: '',
      location: '',
      clinic,
      transactionId: `order:${o.id}`,
      paymentMethod: '',
      source: 'Square API',
    });
  }

  return sales;
}

async function handleStatus(res) {
  const clinics = resolveClinics();
  const connected = clinics.filter(c => c.configured).map(c => c.clinic);
  const missing = clinics.filter(c => !c.configured).map(c => ({
    clinic: c.clinic,
    missingToken: !c.token,
    missingLocation: !c.locationId,
  }));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ connectedClinics: connected, missing }));
}

async function handleSync(req, res) {
  const q = getQuery(req);
  const range = defaultMonthRange();
  const from = (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) ? q.from : range.from;
  const to   = (q.to   && /^\d{4}-\d{2}-\d{2}$/.test(q.to))   ? q.to   : range.to;
  const beginRfc = toRFC3339(from, false);
  const endRfc   = toRFC3339(to, true);

  const clinics = resolveClinics();
  const configured = clinics.filter(c => c.configured);

  const results = await Promise.all(configured.map(async c => {
    try {
      const [orders, payments] = await Promise.all([
        fetchOrders(c.token, c.locationId, beginRfc, endRfc),
        fetchPayments(c.token, c.locationId, beginRfc, endRfc),
      ]);
      const sales = buildSalesForClinic(c.clinic, orders, payments);
      return { clinic: c.clinic, sales, ordersCount: orders.length, paymentsCount: payments.length };
    } catch (e) {
      return { clinic: c.clinic, error: e && e.message ? e.message : String(e) };
    }
  }));

  const sales = [];
  const errors = [];
  const perClinic = {};
  for (const r of results) {
    if (r.error) {
      errors.push({ clinic: r.clinic, message: r.error });
      perClinic[r.clinic] = { ok: false, error: r.error };
    } else {
      sales.push(...r.sales);
      perClinic[r.clinic] = { ok: true, count: r.sales.length, orders: r.ordersCount, payments: r.paymentsCount };
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    sales,
    connectedClinics: configured.map(c => c.clinic),
    missingClinics: clinics.filter(c => !c.configured).map(c => c.clinic),
    perClinic,
    errors,
    range: { from, to },
  }));
}

module.exports = async function handler(req, res) {
  const q = getQuery(req);
  const action = (q.action || 'status').toLowerCase();
  try {
    if (action === 'status') return await handleStatus(res);
    if (action === 'sync')   return await handleSync(req, res);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
  }
};
