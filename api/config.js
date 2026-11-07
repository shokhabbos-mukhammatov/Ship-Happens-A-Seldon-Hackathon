// GET /api/config -> public OAuth client IDs for the browser connectors. These are not secrets
// (they ship to every browser); the OAuth tokens themselves never touch this server.
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      microsoftClientId: process.env.MS_CLIENT_ID || null,
    })
  );
}
