/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tingproofApiPlugin } from "./vite-plugin-tingproof-api.js";

// 组合服务：dev 与 preview 都把 /api 与页面放在同一端口（0.0.0.0:5173），
// 任意设备访问 http://<LAN-IP>:5173/ 与 /api 即看到同一个服务端数据库（PRD V1.1.0）。
export default defineConfig({
  plugins: [react(), tingproofApiPlugin()],
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
