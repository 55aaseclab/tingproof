/**
 * 独立生产服务：静态 dist + /api，绑定 0.0.0.0（PRD A1 / 4.4.4）。
 * 开发与预览的“组合服务”由 vite.config.ts 中的 tingproofApiPlugin 承载；
 * 本入口用于不经过 Vite 的纯生产部署（npm run serve）。
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiMiddleware } from "./apiHandler.ts";
import { SqliteProjectStore } from "./sqliteStore.ts";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 5173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

export interface TingProofServerOptions {
  host?: string;
  port?: number;
  distDir?: string;
  dbPath?: string;
}

export function createTingProofServer(options: TingProofServerOptions = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const distDir = resolve(options.distDir ?? join(rootDir, "dist"));
  const dbPath = options.dbPath
    ? resolve(options.dbPath)
    : resolve(process.env.TINGPROOF_DATA_DIR ?? "data", "tingproof.db");
  const store = new SqliteProjectStore(dbPath);
  const api = createApiMiddleware({ store });

  const server = createHttpServer((req, res) => {
    void api(req as IncomingMessage, res as ServerResponse, () => {
      serveStatic(distDir, req, res);
    });
  });
  server.on("close", () => store.close());
  return { server, store, host, port, dbPath };
}

function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse): void {
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
    filePath = join(distDir, "index.html"); // SPA 回退
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("dist 未构建：请先运行 npm run build");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

export function startTingProofServer(options: TingProofServerOptions = {}): ReturnType<typeof createTingProofServer> {
  const instance = createTingProofServer(options);
  instance.server.listen(instance.port, instance.host);
  return instance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = startTingProofServer();
  console.log(`[tingproof] serving dist + /api on http://${instance.host}:${instance.port} (db: ${instance.dbPath})`);
}
