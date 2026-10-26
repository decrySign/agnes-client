/** Open-source demo: operator console is not included. */
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";

export function createAdminApp(_cfg: AppConfig, _db: DatabaseSync): Hono {
  const app = new Hono();
  app.all("*", (c) => c.json({ error: "开源演示仓不含运营后台" }, 404));
  return app;
}