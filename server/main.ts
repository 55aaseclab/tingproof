/** Independent production server for static dist assets and the shared project API. */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiMiddleware } from "./apiHandler.ts";
import { SqliteProjectStore } from "./sqliteStore.ts";
import { imageCacheHeaders, imageNotModified } from "./imageCache.ts";
import { businessSecurity, type BusinessSecurityOptions } from "./businessAssertion.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 5173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

export interface TingProofServerOptions {
  host?: string;
  port?: number;
  distDir?: string;
  dbPath?: string;
  business?: BusinessSecurityOptions;
}

export function createTingProofServer(options: TingProofServerOptions = {}) {
  const business = businessSecurity(options.business);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const distDir = resolve(options.distDir ?? join(rootDir, "dist"));
  const dbPath = options.dbPath
    ? resolve(options.dbPath)
    : resolve(process.env.TINGPROOF_DATA_DIR ?? "data", "tingproof.db");
  const store = new SqliteProjectStore(dbPath);
  const api = createApiMiddleware({ store, business });

  const server = createHttpServer((req, res) => {
    void api(req as IncomingMessage, res as ServerResponse, () => {
      serveStatic(distDir, req, res);
    });
  });
  server.on("close", () => store.close());
  return { server, store, host, port, dbPath };
}

function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed.");
    return;
  }
  const url = new URL(req.url ?? "/", "http://tingproof.local");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid URL");
    return;
  }
  let filePath = normalize(join(distDir, decodedPath));
  // startsWith(distDir) alone would accept a sibling such as /dist-backup;
  // compare the normalized relative path so a LAN client cannot escape distDir.
  const outside = relative(distDir, filePath);
  if (outside.startsWith("..") || isAbsolute(outside)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distDir, "index.html"); // Preserve the existing SPA fallback.
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(req.method === "HEAD" ? undefined : "Static output is unavailable; run npm run build.");
    return;
  }
  try {
    const realRoot = realpathSync(distDir);
    filePath = realpathSync(filePath);
    const actualOutside = relative(realRoot, filePath);
    if (actualOutside === ".." || actualOutside.startsWith("../") || actualOutside.startsWith("..\\") || isAbsolute(actualOutside)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
  } catch {
    res.writeHead(404).end("Not found.");
    return;
  }
  const info = statSync(filePath);
  if (!info.isFile()) { res.writeHead(404).end("Not found."); return; }
  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const cacheHeaders = type.startsWith("image/") ? imageCacheHeaders(info) : null;
  const headers = { "Content-Type": type, ...(cacheHeaders ?? {}) };
  if (cacheHeaders && imageNotModified(req, cacheHeaders)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

export function startTingProofServer(options: TingProofServerOptions = {}): ReturnType<typeof createTingProofServer> {
  const instance = createTingProofServer(options);
  instance.server.listen(instance.port, instance.host);
  return instance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const instance = startTingProofServer({ host: process.env.HOST || DEFAULT_HOST, port });
  console.log(`[tingproof] serving dist + /api on http://${instance.host}:${instance.port} (db: ${instance.dbPath})`);
}
