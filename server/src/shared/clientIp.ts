// clientIp.ts — canonical client-IP resolver for rate limiting / per-IP caps.
//
// Only trust X-Forwarded-For / X-Real-IP when a reverse-proxy hop count is
// configured (TRUST_PROXY_HOPS > 0, default 0 = fail-closed); take the trusted
// hop (parts.length - hops, i.e. the LAST entry nginx appended, NOT the first
// attacker-supplied one); fall back to the socket address. Mirrors the inline
// helpers in AssetServer (clientIp) and UOProxy (clientIpFromReq); uoamHub uses
// THIS so its per-IP DoS cap can't be bypassed by a spoofed X-Forwarded-For
// first-entry (security audit 2026-06-21).

import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import { TRUST_PROXY_HOPS } from './config.js';

export function clientIpFromReq(req: IncomingMessage): string {
  if (TRUST_PROXY_HOPS > 0) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = Math.max(0, parts.length - TRUST_PROXY_HOPS);
      if (parts[idx]) { return parts[idx]; }
    }
    const xri = req.headers['x-real-ip'];
    if (typeof xri === 'string' && xri.length > 0) { return xri; }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * The key a PER-ADDRESS LIMIT counts against: the address itself for IPv4, the /64 for IPv6.
 *
 * 🚨 (audit 2026-10-29, M3). Every per-IP control — the guest-mint cap, the API limiter's guest
 * buckets, the WS upgrade bucket, the 4-sessions-per-IP cap, the map hub's cap — keyed on the full
 * address. An IPv6 /64 is ONE subscriber (any VPS or home line gets 2^64 addresses), so rotating the
 * low bits gave a fresh budget per request: 80 guest mints from 80 addresses of one /64 all passed
 * where one address was capped at 30. Bans, audit logs and anything shown to a person keep the full
 * address; only limit keys go through here. An IPv4-mapped address (::ffff:a.b.c.d) is IPv4.
 */
export function ipBucketKey(ip: string): string {
  const raw = String(ip || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  const addr = raw.replace(/%.*$/, '');            // drop a zone id (fe80::1%eth0)
  if (!isIPv6(addr)) return raw;                   // IPv4, 'unknown', anything unparseable: as is
  const groups = expandIPv6(addr);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : raw;
}

/** The eight 16-bit groups of a valid IPv6 address, as hex without leading zeros. */
function expandIPv6(addr: string): string[] | null {
  let s = addr;
  // An embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) is two more groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((g) => parseInt(g, 16).toString(16));
}
