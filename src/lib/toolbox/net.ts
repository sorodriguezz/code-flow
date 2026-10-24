/**
 * Network tools: URL anatomy, IPv4/IPv6 subnet arithmetic, Unix permissions and User-Agent strings.
 */

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

export interface UrlParts {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  query: [string, string][];
  origin: string;
}

export function parseUrl(text: string): UrlParts {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    // A bare host or path is how people often paste one.
    try {
      url = new URL(`https://${text.trim()}`);
    } catch {
      throw new Error("Not a URL");
    }
  }
  return {
    protocol: url.protocol.replace(/:$/, ""),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    hostname: url.hostname,
    port: url.port,
    pathname: decodeURIComponent(url.pathname),
    hash: url.hash.replace(/^#/, ""),
    query: [...url.searchParams.entries()],
    origin: url.origin,
  };
}

export function buildUrl(p: UrlParts): string {
  const url = new URL(`${p.protocol || "https"}://placeholder`);
  url.hostname = p.hostname;
  url.port = p.port;
  url.username = p.username;
  url.password = p.password;
  url.pathname = p.pathname;
  const params = new URLSearchParams();
  for (const [k, v] of p.query) if (k || v) params.append(k, v);
  url.search = params.toString();
  url.hash = p.hash;
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------------------------

export function parseIpv4(text: string): number {
  const parts = text.trim().split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) throw new Error(`Not an IPv4 address: ${text}`);
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

export function formatIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

export interface Ipv4Subnet {
  address: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  /** Addresses in the block. */
  size: number;
  /** Usable host addresses (/31 and /32 are point-to-point and single host — RFC 3021). */
  hosts: number;
  ipClass: string;
  kind: "private" | "loopback" | "link-local" | "multicast" | "cgnat" | "reserved" | "public";
  binary: string;
}

function ipv4Kind(n: number): Ipv4Subnet["kind"] {
  const a = Math.floor(n / 2 ** 24);
  const b = Math.floor(n / 2 ** 16) % 256;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240 || a === 0) return "reserved";
  return "public";
}

/** `192.168.1.10/24`, or `192.168.1.10 255.255.255.0`, or a bare address (taken as /32). */
export function ipv4Subnet(text: string): Ipv4Subnet {
  const t = text.trim();
  let addrText = t;
  let prefix = 32;
  const slash = /^([\d.]+)\s*\/\s*(\d{1,2})$/.exec(t);
  const mask = /^([\d.]+)\s+([\d.]+)$/.exec(t);
  if (slash) {
    addrText = slash[1];
    prefix = Number(slash[2]);
    if (prefix > 32) throw new Error("The prefix goes from 0 to 32");
  } else if (mask) {
    addrText = mask[1];
    const m = parseIpv4(mask[2]);
    const bits = m.toString(2).padStart(32, "0");
    if (!/^1*0*$/.test(bits)) throw new Error("Not a contiguous netmask");
    prefix = bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
  }
  const addr = parseIpv4(addrText);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(addr / size) * size;
  const broadcast = network + size - 1;
  const maskNum = 2 ** 32 - size;
  const a = Math.floor(addr / 2 ** 24);
  const hosts = prefix >= 31 ? size : size - 2;
  return {
    address: formatIpv4(addr),
    prefix,
    netmask: formatIpv4(maskNum),
    wildcard: formatIpv4(size - 1),
    network: formatIpv4(network),
    broadcast: formatIpv4(broadcast),
    firstHost: formatIpv4(prefix >= 31 ? network : network + 1),
    lastHost: formatIpv4(prefix >= 31 ? broadcast : broadcast - 1),
    size,
    hosts,
    ipClass: a < 128 ? "A" : a < 192 ? "B" : a < 224 ? "C" : a < 240 ? "D" : "E",
    kind: ipv4Kind(addr),
    binary: [24, 16, 8, 0].map((s) => (Math.floor(addr / 2 ** s) % 256).toString(2).padStart(8, "0")).join("."),
  };
}

/** Splits a block into `count` equal subnets (rounded up to a power of two). */
export function splitIpv4(text: string, count: number): string[] {
  const s = ipv4Subnet(text);
  const extra = Math.ceil(Math.log2(Math.max(1, count)));
  const prefix = s.prefix + extra;
  if (prefix > 32) throw new Error("Too many subnets for this block");
  const size = 2 ** (32 - prefix);
  const base = parseIpv4(s.network);
  return Array.from({ length: 2 ** extra }, (_, i) => `${formatIpv4(base + i * size)}/${prefix}`);
}

// ---------------------------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------------------------

export function parseIpv6(text: string): bigint {
  let t = text.trim().replace(/^\[|\]$/g, "").split("%")[0];
  // An embedded IPv4 tail (`::ffff:192.0.2.1`).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (v4) {
    const n = parseIpv4(v4[1]);
    t = t.slice(0, -v4[1].length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) throw new Error(`Not an IPv6 address: ${text}`);
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) throw new Error(`Not an IPv6 address: ${text}`);
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`Not an IPv6 address: ${text}`);
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** RFC 5952: lowercase, leading zeros dropped, the longest run of zero groups as `::`. */
export function formatIpv6(n: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt((7 - i) * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best === -1) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

export function expandIpv6(n: bigint): string {
  return Array.from({ length: 8 }, (_, i) => Number((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16).padStart(4, "0")).join(":");
}

export interface Ipv6Subnet {
  address: string;
  expanded: string;
  prefix: number;
  network: string;
  last: string;
  /** As text: a /64 holds 18 446 744 073 709 551 616 addresses. */
  size: string;
  kind: "loopback" | "link-local" | "unique-local" | "multicast" | "documentation" | "ipv4-mapped" | "global" | "unspecified";
}

export function ipv6Subnet(text: string): Ipv6Subnet {
  const m = /^(.+?)(?:\/(\d{1,3}))?$/.exec(text.trim());
  if (!m) throw new Error("Not an IPv6 address");
  const prefix = m[2] === undefined ? 128 : Number(m[2]);
  if (prefix > 128) throw new Error("The prefix goes from 0 to 128");
  const addr = parseIpv6(m[1]);
  const hostBits = BigInt(128 - prefix);
  const mask = ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  const network = addr & mask;
  const last = network | ((1n << hostBits) - 1n);
  const top = Number(addr >> 112n);
  const kind: Ipv6Subnet["kind"] =
    addr === 0n ? "unspecified"
    : addr === 1n ? "loopback"
    : (top & 0xffc0) === 0xfe80 ? "link-local"
    : (top & 0xfe00) === 0xfc00 ? "unique-local"
    : (top & 0xff00) === 0xff00 ? "multicast"
    : addr >> 96n === 0xffffn ? "ipv4-mapped"
    : addr >> 96n === 0x20010db8n ? "documentation"
    : "global";
  return {
    address: formatIpv6(addr),
    expanded: expandIpv6(addr),
    prefix,
    network: `${formatIpv6(network)}/${prefix}`,
    last: formatIpv6(last),
    size: (1n << hostBits).toString(),
    kind,
  };
}

// ---------------------------------------------------------------------------------------------
// chmod
// ---------------------------------------------------------------------------------------------

/** `[owner, group, others]` × `[read, write, execute]`, plus the setuid/setgid/sticky bits. */
export interface Permissions {
  bits: boolean[][];
  special: { setuid: boolean; setgid: boolean; sticky: boolean };
}

export function permissionsFromOctal(text: string): Permissions {
  const t = text.trim();
  if (!/^[0-7]{3,4}$/.test(t)) throw new Error("Three or four octal digits, like 755 or 4755");
  const digits = t.padStart(4, "0").split("").map(Number);
  return {
    special: { setuid: !!(digits[0] & 4), setgid: !!(digits[0] & 2), sticky: !!(digits[0] & 1) },
    bits: digits.slice(1).map((d) => [!!(d & 4), !!(d & 2), !!(d & 1)]),
  };
}

export function permissionsToOctal(p: Permissions): string {
  const special = (p.special.setuid ? 4 : 0) + (p.special.setgid ? 2 : 0) + (p.special.sticky ? 1 : 0);
  const rest = p.bits.map(([r, w, x]) => (r ? 4 : 0) + (w ? 2 : 0) + (x ? 1 : 0)).join("");
  return special ? `${special}${rest}` : rest;
}

/** `rwxr-xr-x`, with `s`/`S` and `t`/`T` where the special bits are. */
export function permissionsToSymbolic(p: Permissions): string {
  const specials = [p.special.setuid, p.special.setgid, p.special.sticky];
  return p.bits
    .map(([r, w, x], i) => {
      const exec = specials[i] ? (i === 2 ? (x ? "t" : "T") : x ? "s" : "S") : x ? "x" : "-";
      return `${r ? "r" : "-"}${w ? "w" : "-"}${exec}`;
    })
    .join("");
}

export function permissionsFromSymbolic(text: string): Permissions {
  const t = text.trim().replace(/^[-dlbcps]?(?=[rwxsStT-]{9}$)/, "");
  if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(t)) throw new Error("Nine characters like rwxr-xr-x");
  const bits = [0, 1, 2].map((g) => [t[g * 3] === "r", t[g * 3 + 1] === "w", /[xst]/.test(t[g * 3 + 2])]);
  return { bits, special: { setuid: /[sS]/.test(t[2]), setgid: /[sS]/.test(t[5]), sticky: /[tT]/.test(t[8]) } };
}

// ---------------------------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------------------------

export interface UserAgentInfo {
  browser: string;
  browserVersion: string;
  engine: string;
  os: string;
  osVersion: string;
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
}

export function parseUserAgent(ua: string): UserAgentInfo {
  const find = (re: RegExp) => re.exec(ua)?.[1] ?? "";
  let browser = "";
  let browserVersion = "";
  const browsers: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Vivaldi", /Vivaldi\/([\d.]+)/],
    ["Brave", /Brave\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
    ["Internet Explorer", /(?:MSIE |rv:)([\d.]+)\) like Gecko|MSIE ([\d.]+)/],
    ["curl", /curl\/([\d.]+)/],
    ["Postman", /PostmanRuntime\/([\d.]+)/],
    ["okhttp", /okhttp\/([\d.]+)/],
    ["Python requests", /python-requests\/([\d.]+)/],
    ["Node.js", /node(?:-fetch)?\/([\d.]+)/i],
  ];
  for (const [name, re] of browsers) {
    const m = re.exec(ua);
    if (m) {
      browser = name;
      browserVersion = m[1] ?? m[2] ?? "";
      break;
    }
  }
  const engine = /Gecko\/\d/.test(ua) && /Firefox/.test(ua) ? "Gecko" : /Chrome|Chromium|Edg/.test(ua) ? "Blink" : /AppleWebKit/.test(ua) ? "WebKit" : /Trident/.test(ua) ? "Trident" : "";
  let os = "";
  let osVersion = "";
  if (/Windows NT/.test(ua)) {
    os = "Windows";
    const nt = find(/Windows NT ([\d.]+)/);
    osVersion = ({ "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" } as Record<string, string>)[nt] ?? nt;
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    os = "iOS";
    osVersion = find(/OS ([\d_]+)/).replace(/_/g, ".");
  } else if (/Mac OS X/.test(ua)) {
    os = "macOS";
    osVersion = find(/Mac OS X ([\d_.]+)/).replace(/_/g, ".");
  } else if (/Android/.test(ua)) {
    os = "Android";
    osVersion = find(/Android ([\d.]+)/);
  } else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";
  const bot = /bot|crawler|spider|slurp|curl|wget|python|postman|okhttp|node/i.test(ua);
  const device: UserAgentInfo["device"] = bot
    ? "bot"
    : /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /Mobi|iPhone|Android/.test(ua)
        ? "mobile"
        : os
          ? "desktop"
          : "unknown";
  return { browser, browserVersion, engine, os, osVersion, device };
}
