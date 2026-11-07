// GET /api/health -> {ai: true|false}. Never reveals the key.
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ai: Boolean(process.env.ANTHROPIC_API_KEY), model: 'claude-haiku-5-5' }));
}
