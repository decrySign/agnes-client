/** Open-source demo stub: no ip2region DB shipped. */
export function initGeoIp(_dbPath: string): boolean {
  return false;
}

export function geoIpReady(): boolean {
  return false;
}

function normalize(ip: string): string {
  const v = (ip || "").trim().toLowerCase();
  if (v.startsWith("::ffff:")) return v.slice(7);
  return v;
}

function ipToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let long = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    long = long * 256 + n;
  }
  return long >>> 0;
}

function classify(ip: string): "loopback" | "private" | "cgnat" | null {
  if (ip === "::1") return "loopback";
  const long = ipToLong(ip);
  if (long === null) return null;
  const a = (long >>> 24) & 0xff;
  const b = (long >>> 16) & 0xff;
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return null;
}

export function ipSource(ip: string): string {
  const clean = normalize(ip);
  const kind = classify(clean);
  if (kind === "loopback") return "本机";
  if (kind === "private" || kind === "cgnat") return "内网";
  return "公网";
}