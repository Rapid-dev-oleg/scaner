// Minimal single-password auth. Set AUTH_PASSWORD to protect the API.
// If AUTH_PASSWORD is unset/empty, auth is disabled (open) and the frontend
// skips the login screen.
const crypto = require('crypto');

const PASSWORD = process.env.AUTH_PASSWORD || '';
const enabled = PASSWORD.length > 0;
const tokens = new Set();

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function login(password) {
  if (!enabled) return { ok: true, token: null };
  if (!timingSafeEqual(password || '', PASSWORD)) return { ok: false };
  const token = crypto.randomBytes(32).toString('hex');
  tokens.add(token);
  return { ok: true, token };
}

function logout(token) {
  tokens.delete(token);
}

function isValid(token) {
  return !enabled || (token && tokens.has(token));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  // EventSource can't set headers — allow ?token= for the SSE stream.
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

// Express middleware protecting /api routes (except public ones)
const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/status']);
function middleware(req, res, next) {
  if (!enabled) return next();
  if (req.method === 'OPTIONS') return next();
  // Only guard the API — the frontend (HTML/JS/CSS + login screen) is public.
  if (!req.path.startsWith('/api')) return next();
  if (PUBLIC.has(req.path)) return next();
  if (isValid(bearer(req))) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { enabled, login, logout, isValid, bearer, middleware };
