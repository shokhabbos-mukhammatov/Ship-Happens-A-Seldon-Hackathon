// GET /api/ics?url=<https:// or webcal:// link> -> the calendar as text/calendar.
// A pass-through proxy because calendar servers do not send CORS headers. Nothing is stored.
// SSRF guard: https only, no credentials or odd ports, and every resolved address (checked inside
// the socket's own DNS lookup, so a re-resolve cannot swap in a private IP) must be public.
// The URL contains a secret token: it is never logged and never echoed back in errors.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class IcsProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function expandIpv6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // Trailing dotted IPv4 (::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges (v4 + v6). */
export function isPrivateAddress(ip) {
  const addr = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const kind = net.isIP(addr.split('%')[0]);
  if (kind === 4) {
    const n = ipv4ToInt(addr);
    if (n === null) return true;
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (kind === 6) {
    const g = expandIpv6(addr);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(embeddedV4()); // v4-mapped / v4-compatible
    if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateAddress(embeddedV4()); // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x2002) return isPrivateAddress(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
    return false;
  }
  return true; // not an IP at all: refuse
}

const BLOCKED_HOST_RE = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;

/**
 * Syntactic check. Returns the https URL (webcal:// rewritten) or throws IcsProxyError(400).
 * Hostnames are checked again after DNS resolution by `safeLookup`.
 */
export function validateIcsUrl(raw) {
  const str = String(raw || '').trim();
  if (!str) throw new IcsProxyError(400, 'Missing ?url= parameter.');
  if (str.length > 4096) throw new IcsProxyError(400, 'That link is too long.');
  let u;
  try {
    u = new URL(str.replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new IcsProxyError(400, 'That is not a valid link.');
  }
  if (u.protocol !== 'https:') throw new IcsProxyError(400, 'Only https:// and webcal:// calendar links are allowed.');
  if (u.username || u.password) throw new IcsProxyError(400, 'Links with a username or password are not allowed.');
  if (u.port && u.port !== '443') throw new IcsProxyError(400, 'Only the standard https port is allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || BLOCKED_HOST_RE.test(host) || !host.includes('.') && !net.isIP(host)) {
    throw new IcsProxyError(400, 'That host is not allowed (local or private network).');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new IcsProxyError(400, 'That host is not allowed (local or private network).');
  u.hash = '';
  return u;
}

/** Resolves a hostname and fails if any address is private. Exported for tests and pre-checks. */
export async function assertPublicHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new IcsProxyError(400, 'That host is not allowed (local or private network).');
    return [{ address: host, family: net.isIP(host) }];
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new IcsProxyError(400, 'Could not find that calendar server (DNS lookup failed).');
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new IcsProxyError(400, 'That host is not allowed (it resolves to a local or private network).');
  }
  return addrs;
}

/** net/tls `lookup` hook: the socket connects only to the addresses we validated. */
function safeLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options ? options : {};
  assertPublicHost(hostname).then(
    (addrs) => {
      const fam = opts.family === 4 || opts.family === 6 ? opts.family : 0;
      const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
      if (!list.length) return cb(Object.assign(new Error('No usable address'), { code: 'ENOTFOUND' }));
      if (opts.all) return cb(null, list.map((a) => ({ address: a.address, family: a.family })));
      return cb(null, list[0].address, list[0].family);
    },
    (err) => cb(err)
  );
}

function fetchOnce(url, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new IcsProxyError(504, 'The calendar server took too long (over 8 seconds).'));
    const req = https.get(
      url,
      {
        lookup: safeLookup,
        headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'Accept-Encoding': 'gzip, deflate', 'User-Agent': 'Bouncer-ICS/1.0' },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          const hint = status === 404 || status === 410 ? ' The link may have been reset; copy it again.' : status === 401 || status === 403 ? ' The calendar is private; use the secret iCal address.' : '';
          return reject(new IcsProxyError(502, `The calendar server answered HTTP ${status}.${hint}`));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          return reject(new IcsProxyError(413, 'That calendar is larger than 2 MB.'));
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            stream.destroy();
            reject(new IcsProxyError(413, 'That calendar is larger than 2 MB.'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', () => reject(new IcsProxyError(502, 'The calendar download failed.')));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new IcsProxyError(504, 'The calendar server took too long (over 8 seconds).'));
    }, remaining);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof IcsProxyError ? err : new IcsProxyError(502, err?.code === 'ENOTFOUND' ? 'Could not find that calendar server.' : 'Could not connect to the calendar server.'));
    });
  });
}

/** Fetches an ICS feed with the SSRF guard, redirects (each re-validated), timeout and size cap. */
export async function fetchIcs(rawUrl) {
  let url = validateIcsUrl(rawUrl);
  const deadline = Date.now() + TIMEOUT_MS;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchOnce(url, deadline);
    if (r.redirect === undefined) {
      if (!/BEGIN:VCALENDAR/i.test(r.body.slice(0, 4096))) {
        throw new IcsProxyError(422, 'That link did not return an ICS calendar (it looks like a web page). Use the iCal/ICS address.');
      }
      return r.body;
    }
    let next;
    try {
      next = new URL(r.redirect, url).href;
    } catch {
      throw new IcsProxyError(502, 'The calendar server sent a broken redirect.');
    }
    url = validateIcsUrl(next);
  }
  throw new IcsProxyError(502, 'Too many redirects.');
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Use GET.' });
  }
  const raw = req.query?.url ?? new URL(req.url || '/', 'http://local').searchParams.get('url');
  try {
    const body = await fetchIcs(Array.isArray(raw) ? raw[0] : raw);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(body);
  } catch (err) {
    // Deliberately no logging: the URL is a bearer secret.
    if (err instanceof IcsProxyError) return sendJson(res, err.status, { error: err.message });
    return sendJson(res, 502, { error: 'Could not fetch that calendar.' });
  }
}
