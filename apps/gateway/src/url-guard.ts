import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// SSRF protection for admin-registered upstream URLs.
//  1. Registration time: scheme/userinfo checks and a DNS check give the admin a clear error.
//  2. Connection time: every socket the gateway opens to an upstream goes through guardedLookup, so the
//     address that is actually dialled is checked. This defeats DNS rebinding (a name that resolved to a
//     public IP at registration and to 169.254.169.254 later) because there is no second, unchecked lookup.
//  3. Redirects are refused, so an allowed host cannot bounce us to a forbidden one.

/** Never reachable, whatever the allow-list says: link-local (cloud metadata), unspecified, multicast. */
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // AWS/GCP/Azure metadata, link-local
ALWAYS_BLOCKED.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud metadata
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addAddress('::', 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');
ALWAYS_BLOCKED.addAddress('fd00:ec2::254', 'ipv6'); // AWS IPv6 metadata

/** Internal ranges: only reachable for hosts on the configured allow-list (e.g. *.svc.cluster.local). */
const INTERNAL = new BlockList();
INTERNAL.addSubnet('127.0.0.0', 8, 'ipv4');
INTERNAL.addSubnet('10.0.0.0', 8, 'ipv4');
INTERNAL.addSubnet('172.16.0.0', 12, 'ipv4');
INTERNAL.addSubnet('192.168.0.0', 16, 'ipv4');
INTERNAL.addSubnet('100.64.0.0', 10, 'ipv4');
INTERNAL.addAddress('::1', 'ipv6');
INTERNAL.addSubnet('fc00::', 7, 'ipv6');

export class UrlPolicyError extends Error {}

function family(ip: string): 'ipv4' | 'ipv6' {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    return pat.startsWith('*.') ? h.endsWith(pat.slice(1)) : h === pat;
  });
}

/** Throws UrlPolicyError if `ip` must not be dialled for `host`. */
export function checkAddress(host: string, ip: string, allowedHosts: string[]): void {
  const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
  const fam = family(mapped);
  if (ALWAYS_BLOCKED.check(mapped, fam)) throw new UrlPolicyError(`address ${ip} is never allowed`);
  if (INTERNAL.check(mapped, fam) && !hostAllowed(host, allowedHosts)) {
    throw new UrlPolicyError(`host ${host} resolves to internal address ${ip} and is not on the allow-list`);
  }
}

type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs.map((a) => a.address)),
    ),
  );

/** Registration-time validation. Returns the normalized URL string. */
export async function validateUpstreamUrl(
  raw: string,
  allowedHosts: string[],
  resolve: Resolver = systemResolver,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlPolicyError('only http(s) URLs');
  if (url.username || url.password) throw new UrlPolicyError('credentials in URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let ips: string[];
  try {
    ips = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new UrlPolicyError(`cannot resolve ${host}`);
  }
  for (const ip of ips) checkAddress(host, ip, allowedHosts);
  url.hash = '';
  return url.toString();
}

/** A fetch whose sockets can only connect to addresses permitted by the policy, and which never follows redirects. */
export function createGuardedFetch(allowedHosts: string[]): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
          if (err) return callback(err, '', 0);
          try {
            for (const a of addrs) checkAddress(hostname, a.address, allowedHosts);
          } catch (e) {
            return callback(e as Error, '', 0);
          }
          if ((options as { all?: boolean }).all)
            return (callback as (e: null, a: LookupAddress[]) => void)(null, addrs);
          const first = addrs[0] as LookupAddress;
          callback(null, first.address, first.family);
        });
      },
    },
  });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname.replace(
      /^\[|\]$/g,
      '',
    );
    // IP literals skip DNS lookup inside the socket layer, so check them here.
    if (isIP(host)) checkAddress(host, host, allowedHosts);
    // biome-ignore lint/suspicious/noExplicitAny: undici's fetch types differ slightly from the DOM lib's.
    return undiciFetch(input as any, { ...(init as any), redirect: 'error', dispatcher: agent }) as any;
  }) as typeof fetch;
}
