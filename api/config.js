// GET /api/config -> public OAuth client IDs for the browser connectors. These are not secrets
// (they ship to every browser); the OAuth tokens themselves never touch this server.

/** Tolerate copy-paste slips in the env var: spaces, quotes, a leading https://, a trailing slash. */
export function cleanClientId(raw) {
  const v = String(raw ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
    .trim();
  return v || null;
}

export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      googleClientId: cleanClientId(process.env.GOOGLE_CLIENT_ID),
      microsoftClientId: cleanClientId(process.env.MS_CLIENT_ID),
    })
  );
}
