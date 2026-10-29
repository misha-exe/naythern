// services/urlGuard.js - stops "upload from URL" being used to make the server fetch internal addresses (SSRF).
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  return true;
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('That video URL is not valid.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Video URLs must start with http:// or https://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That video URL is not allowed.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Could not find that video URL host.');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That video URL is not allowed.');
  return u.toString();
}

module.exports = { assertPublicUrl };
