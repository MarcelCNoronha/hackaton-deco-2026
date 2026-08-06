import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export class SafeUrlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeUrlFetchError";
  }
}

export interface SafeUrlFetchOptions {
  init?: RequestInit;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  allowTruncated?: boolean;
}

export interface SafeUrlFetchResult {
  response: Response;
  body: Buffer;
  finalUrl: string;
  truncated: boolean;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isIPv4InCidr(address: string, cidr: string, bits: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(cidr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const version = isIP(mappedIpv4);

  if (version === 4) {
    return BLOCKED_IPV4_CIDRS.some(([cidr, bits]) => isIPv4InCidr(mappedIpv4, cidr, bits));
  }

  if (version === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    const firstHextet = parseInt(normalized.split(":")[0] || "0", 16);
    return (
      (firstHextet & 0xffc0) === 0xfe80 ||
      (firstHextet & 0xfe00) === 0xfc00 ||
      (firstHextet & 0xff00) === 0xff00
    );
  }

  return false;
}

async function assertUrlIsAllowed(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeUrlFetchError("URL deve usar http ou https.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    throw new SafeUrlFetchError("URL aponta para host local bloqueado.");
  }

  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new SafeUrlFetchError("URL aponta para endereco IP interno/bloqueado.");
    }
    return;
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new SafeUrlFetchError("URL nao resolveu DNS.");

  const blocked = records.find((record) => isBlockedIpAddress(record.address));
  if (blocked) {
    throw new SafeUrlFetchError(`URL resolve para endereco IP interno/bloqueado (${blocked.address}).`);
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  allowTruncated: boolean,
): Promise<{ body: Buffer; truncated: boolean }> {
  const contentLength = response.headers.get("content-length");
  if (!allowTruncated && contentLength && Number(contentLength) > maxBytes) {
    throw new SafeUrlFetchError(`Resposta excede o limite de ${maxBytes} bytes.`);
  }

  if (!response.body) return { body: Buffer.alloc(0), truncated: false };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      if (!allowTruncated) {
        await reader.cancel();
        throw new SafeUrlFetchError(`Resposta excede o limite de ${maxBytes} bytes.`);
      }

      const remaining = maxBytes - (total - value.byteLength);
      if (remaining > 0) chunks.push(Buffer.from(value.slice(0, remaining)));
      await reader.cancel();
      return { body: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(value));
  }

  return { body: Buffer.concat(chunks), truncated: false };
}

function isRedirect(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status);
}

export async function safeUrlFetch(url: string, options: SafeUrlFetchOptions): Promise<SafeUrlFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = new URL(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    await assertUrlIsAllowed(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        ...options.init,
        redirect: "manual",
        signal: controller.signal,
      });

      if (isRedirect(response)) {
        const location = response.headers.get("location");
        if (!location) return { response, body: Buffer.alloc(0), finalUrl: currentUrl.toString(), truncated: false };
        currentUrl = new URL(location, currentUrl);
        continue;
      }

      const { body, truncated } = await readBodyWithLimit(response, options.maxBytes, options.allowTruncated ?? false);
      return { response, body, finalUrl: currentUrl.toString(), truncated };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new SafeUrlFetchError(`URL excedeu ${maxRedirects} redirects.`);
}
