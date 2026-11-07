// GET /api/todoist (header Authorization: Bearer <personal API token>) -> {results: Task[]}
// Forwards the user's token to Todoist's API v1 (the REST v2 endpoints now answer 410 Gone).
// The token is never stored or logged; it only lives for the length of this request.
const TODOIST_TASKS = 'https://api.todoist.com/api/v1/tasks';
const MAX_PAGES = 5; // 5 x 200 = 1000 active tasks is plenty for "what now"
const TIMEOUT_MS = 8000;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/** Pulls the token from "Authorization: Bearer x" (preferred) or a JSON body {token}. */
export function tokenFrom(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,200})\s*$/.exec(String(h));
  if (m) return m[1];
  const t = req.body && typeof req.body === 'object' ? req.body.token : null;
  return typeof t === 'string' && /^[A-Za-z0-9._~+/=-]{10,200}$/.test(t.trim()) ? t.trim() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Use GET with an Authorization header.' });
  }
  const token = tokenFrom(req);
  if (!token) return sendJson(res, 400, { error: 'Paste your Todoist API token (Settings, Integrations, Developer).' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const results = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ limit: '200' });
      if (cursor) qs.set('cursor', cursor);
      const r = await fetch(`${TODOIST_TASKS}?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (r.status === 401 || r.status === 403) return sendJson(res, 401, { error: 'Todoist rejected that token. Copy it again from Settings, Integrations, Developer.' });
      if (r.status === 429) return sendJson(res, 429, { error: 'Todoist is rate limiting us. Wait a minute and try again.' });
      if (!r.ok) return sendJson(res, 502, { error: `Todoist answered HTTP ${r.status}.` });
      const data = await r.json();
      results.push(...(Array.isArray(data.results) ? data.results : []));
      cursor = data.next_cursor || null;
      if (!cursor) break;
    }
    return sendJson(res, 200, { results });
  } catch (err) {
    return sendJson(res, err?.name === 'AbortError' ? 504 : 502, { error: err?.name === 'AbortError' ? 'Todoist took too long to answer.' : 'Could not reach Todoist.' });
  } finally {
    clearTimeout(timer);
  }
}
