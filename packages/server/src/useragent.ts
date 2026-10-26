export type UserAgentInfo = { os: string; browser: string };

const EMPTY: UserAgentInfo = { os: "", browser: "" };

function pick(re: RegExp, ua: string): string {
  const m = ua.match(re);
  return m ? (m[1] ?? "").replace(/_/g, ".") : "";
}

function parseOs(ua: string): string {
  if (/windows nt 10\.0/i.test(ua)) return "Windows 10/11";
  if (/windows nt 6\.3/i.test(ua)) return "Windows 8.1";
  if (/windows nt 6\.2/i.test(ua)) return "Windows 8";
  if (/windows nt 6\.1/i.test(ua)) return "Windows 7";
  if (/windows phone/i.test(ua)) return "Windows Phone";
  if (/windows/i.test(ua)) return "Windows";
  if (/android/i.test(ua)) {
    const v = pick(/android[ \/]([\d.]+)/i, ua);
    return v ? `Android ${v}` : "Android";
  }
  if (/(iphone|ipad|ipod)/i.test(ua)) {
    const v = pick(/os ([\d_]+)/i, ua);
    return v ? `iOS ${v}` : "iOS";
  }
  if (/mac os x/i.test(ua)) {
    const v = pick(/mac os x ([\d_]+)/i, ua);
    return v ? `macOS ${v}` : "macOS";
  }
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/linux/i.test(ua)) return "Linux";
  return "";
}

function parseBrowser(ua: string): string {
  let v = pick(/edg(?:e|a|ios)?\/([\d.]+)/i, ua);
  if (v) return `Edge ${v}`;
  v = pick(/opr\/([\d.]+)/i, ua) || pick(/opera[ \/]([\d.]+)/i, ua);
  if (v) return `Opera ${v}`;
  if (/micromessenger/i.test(ua)) {
    v = pick(/micromessenger\/([\d.]+)/i, ua);
    return v ? `WeChat ${v}` : "WeChat";
  }
  v = pick(/firefox\/([\d.]+)/i, ua);
  if (v) return `Firefox ${v}`;
  v = pick(/chrome\/([\d.]+)/i, ua);
  if (v && !/edg|opr/i.test(ua)) return `Chrome ${v}`;
  if (/safari/i.test(ua)) {
    v = pick(/version\/([\d.]+)/i, ua);
    return v ? `Safari ${v}` : "Safari";
  }
  if (/electron/i.test(ua)) {
    v = pick(/electron\/([\d.]+)/i, ua);
    return v ? `Electron ${v}` : "Electron";
  }
  if (/curl\//i.test(ua)) return "curl";
  if (/node|undici|axios|python-requests|okhttp/i.test(ua)) return "程序/脚本";
  return "";
}

export function parseUserAgent(userAgent: string | undefined | null): UserAgentInfo {
  const ua = String(userAgent ?? "").trim();
  if (!ua) return EMPTY;
  return { os: parseOs(ua), browser: parseBrowser(ua) };
}
