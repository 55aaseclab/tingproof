import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, preview, type HttpServer, type InlineConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import viteConfig from "../vite.config.js";

function readWithHost(server: HttpServer, hostname: string, path = "/") {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      headers: { Host: `${hostname}:${address.port}` },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Host check request timed out")));
    req.end();
  });
}

describe("Vite deployment host allowlist", () => {
  it.each(["dev", "preview"] as const)(
    "%s accepts deployment and loopback hosts while rejecting unrelated names",
    async (mode) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "tingproof-vite-host-"));
      const fixtureHtml = "<!doctype html><html><body>Host gate fixture</body></html>";
      writeFileSync(join(fixtureRoot, "index.html"), fixtureHtml);
      mkdirSync(join(fixtureRoot, "dist"));
      writeFileSync(join(fixtureRoot, "dist", "index.html"), fixtureHtml);
      vi.stubEnv("TINGPROOF_DATA_DIR", join(fixtureRoot, "data"));

      const config: InlineConfig = {
        ...viteConfig,
        configFile: false,
        envFile: false,
        root: fixtureRoot,
        publicDir: false,
        cacheDir: join(fixtureRoot, ".vite"),
        logLevel: "silent",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          ...viteConfig.server,
          host: "127.0.0.1",
          port: 0,
          strictPort: true,
          hmr: false,
          watch: null,
        },
        preview: { ...viteConfig.preview, host: "127.0.0.1", port: 0, strictPort: true },
        build: { outDir: "dist" },
      };
      let close: (() => Promise<void>) | undefined;
      try {
        let httpServer: HttpServer;
        if (mode === "dev") {
          const server = await createServer(config);
          close = () => server.close();
          if (!server.httpServer) throw new Error("Expected Vite HTTP server");
          httpServer = server.httpServer;
          // Vite 6 maps dev port 0 to 5173; ask its HTTP server for an OS-assigned port.
          await new Promise<void>((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(0, "127.0.0.1", () => {
              httpServer.off("error", reject);
              resolve();
            });
          });
        } else {
          const server = await preview(config);
          close = () => server.close();
          httpServer = server.httpServer;
        }

        for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
          const response = await readWithHost(httpServer, hostname);
          expect(response.status, hostname).toBe(200);
          expect(response.body, hostname).toContain("Host gate fixture");
        }
        for (const hostname of ["example.test", "child.example.invalid", "localhost.example.test"]) {
          const response = await readWithHost(httpServer, hostname);
          expect(response.status, hostname).toBe(403);
          expect(response.body, hostname).toContain("Blocked request");
        }

        const api = await readWithHost(httpServer, "localhost", "/api/projects");
        expect(api.status).toBe(200);
        expect(JSON.parse(api.body)).toEqual({ projects: [] });
      } finally {
        await close?.();
        vi.unstubAllEnvs();
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    15000,
  );
});
