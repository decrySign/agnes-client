import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { applyDesktopWorkspace, loadConfig, type AppConfig } from "./config.js";
import { describeIpPolicy } from "./security.js";
import { openDb } from "./db.js";
import { initGeoIp } from "./geoip.js";
import { disposeSharedMcpHub, disposeSharedBgTerminalHub } from "@agnes/agent";

export type AgnesListener = {
  cfg: AppConfig;
  close: () => Promise<void>;
};

export function listenAgnes(repoRoot: string): AgnesListener {
  const cfg = loadConfig(repoRoot);
  if (!cfg.webDist) {
    const built = path.join(repoRoot, "apps/web/dist");
    if (fs.existsSync(built)) cfg.webDist = built;
  }
  if (!cfg.adminDist) {
    const built = path.join(repoRoot, "apps/admin/dist");
    if (fs.existsSync(built)) cfg.adminDist = built;
  }
  const db = openDb(cfg.dataDir);
  applyDesktopWorkspace(db, cfg);
  const geoReady = initGeoIp(cfg.ip2regionDb);
  const app = createApp(cfg, db);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(`Agnes server http://${info.address}:${info.port}`);
    if (cfg.desktopMode) console.log(`workspace: ${cfg.workspaceRoot}`);
    console.log(`sqlite: ${cfg.dataDir} (${cfg.desktopMode ? "local-only" : "server"})`);
    console.log(`api key: ${cfg.apiKey ? "configured" : "MISSING (set AGNES_API_KEY in repo-root .env, then restart)"}`);
    if (!cfg.desktopMode) console.log(`ip2region: ${geoReady ? cfg.ip2regionDb : "not loaded (IP 归属地降级为 本机/内网/公网)"}`);
    if (!cfg.desktopMode) {
      console.log(`visitor ips: ${cfg.allowedIps.allowAll ? "any (rate-limited)" : describeIpPolicy(cfg.allowedIps)}`);
      console.log(
        `ip fuse: trial ${cfg.webQuota.hourTrial}/h ${cfg.webQuota.fiveHourTrial}/5h, chat ${cfg.webQuota.hourChat}/h ${cfg.webQuota.fiveHourChat}/5h, daily chat ${cfg.webQuota.dailyChat}/day, image ${cfg.webQuota.dailyImage}/day, video ${cfg.webQuota.videoLimit}/${cfg.webQuota.videoDays}d`,
      );
      if (cfg.trustProxy) console.log(`trust proxy: on (hops ${describeIpPolicy(cfg.trustedProxies)})`);
      console.log("admin: not included in open-source demo");
    }
  });
  return {
    cfg,
    close: async () => {
      await disposeSharedMcpHub().catch(() => {});
      disposeSharedBgTerminalHub();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
