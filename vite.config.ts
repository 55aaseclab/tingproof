/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tingproofApiPlugin } from "./vite-plugin-tingproof-api.js";

const deploymentHosts = (process.env.TINGPROOF_ALLOWED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);

// Dev and preview serve pages and /api on the same port (127.0.0.1:5173).
// Every device uses the same server-side database (PRD V1.1.0).
export default defineConfig({
  plugins: [react(), tingproofApiPlugin()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    allowedHosts: deploymentHosts,
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    allowedHosts: deploymentHosts,
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
