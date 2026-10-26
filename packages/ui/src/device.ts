let cachedHash = "";

declare global {
  interface Window {
    agnesDesktop?: {
      /** remember=false 时只返回路径，不覆盖全局默认工作区 */
      pickFolder: (opts?: { remember?: boolean }) => Promise<string | null>;
      saveSecret: (apiKey: string) => Promise<void>;
      deviceHash: () => Promise<string>;
      appVersion: () => Promise<string>;
      checkUpdate?: () => Promise<{ status: string; message: string; version?: string }>;
    };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function resolveDeviceHash(): Promise<string> {
  if (cachedHash) return cachedHash;
  const desktop = window.agnesDesktop?.deviceHash;
  if (desktop) {
    cachedHash = await desktop();
    return cachedHash;
  }
  let installId = localStorage.getItem("agnes_install_id");
  if (!installId) {
    installId = crypto.randomUUID();
    localStorage.setItem("agnes_install_id", installId);
  }
  cachedHash = await sha256Hex(`agnes-device:v1:web:${installId}`);
  return cachedHash;
}

export function currentDeviceHash(): string {
  return cachedHash;
}
