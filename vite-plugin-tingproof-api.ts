/**
 * Vite 插件：把 TingProof 服务端 API 挂进同一个 Vite 进程——
 * - dev：configureServer（在 Vite 内部中间件之前处理 /api/*）；
 * - preview：configurePreviewServer（生产构建后的组合服务）。
 * 因此 http://<LAN-IP>:5173/ 与 http://<LAN-IP>:5173/api 同源、同一个 SQLite 数据库。
 */
import { resolve } from "node:path";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import { createApiMiddleware } from "./server/apiHandler.ts";
import { SqliteProjectStore } from "./server/sqliteStore.ts";

export const TINGPROOF_API_PLUGIN_NAME = "tingproof-api";

export function resolveDataDbPath(): string {
  const dir = process.env.TINGPROOF_DATA_DIR ?? "data";
  return resolve(dir, "tingproof.db");
}

export function tingproofApiPlugin(): Plugin {
  let store: SqliteProjectStore | null = null;
  const closeStore = () => {
    store?.close();
    store = null;
  };
  function middleware(): Connect.NextHandleFunction {
    if (!store) store = new SqliteProjectStore(resolveDataDbPath());
    const handler = createApiMiddleware({ store });
    return (req, res, next) => {
      void handler(req, res, next);
    };
  }
  return {
    name: TINGPROOF_API_PLUGIN_NAME,
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware());
      // configureServer 返回值是“内部中间件之后的 post hook”，不是关闭钩子；
      // 监听 HTTP server close 才能在热重载/退出时释放 SQLite 文件句柄。
      server.httpServer?.once("close", closeStore);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(middleware());
      server.httpServer?.once("close", closeStore);
    },
  };
}
