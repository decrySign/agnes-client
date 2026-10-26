import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@agnes/ui": path.resolve(rootDir, "../../packages/ui/src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: { allow: [path.resolve(rootDir, "../..")] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5173,
  },
});
