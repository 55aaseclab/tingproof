/**
 * 服务端测试基础设施：真实的 HTTP + SQLite（临时目录文件库），可重启模拟服务进程重启；
 * V1.1.4：可注入假预筛模型（prefilterModel）。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiMiddleware } from "../server/apiHandler.js";
import { SqliteProjectStore } from "../server/sqliteStore.js";
import type { PrefilterModel } from "../server/prefilterModel.ts";
import type { SegmentStatus } from "../src/store/types.js";

export interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
}

export interface TestServer {
  baseUrl: string;
  dbPath: string;
  store: SqliteProjectStore;
  req: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResult>;
  /** 模拟服务进程重启：关闭 HTTP + 数据库连接，再以同一数据库文件重新打开。
   *  可选覆盖 prefilterModel（模拟服务重启后模型配置变更，仍复用同一 temp dbPath）。 */
  restart: (opts?: { prefilterModel?: PrefilterModel }) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function startTestServer(
  opts: { prefilterModel?: PrefilterModel } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "tingproof-test-"));
  const dbPath = join(dir, "tingproof.db");
  let store = new SqliteProjectStore(dbPath);
  // 可变当前模型：restart({ prefilterModel }) 可覆盖（模拟服务重启后配置变更）。
  let currentModel = opts.prefilterModel;
  let middleware = createApiMiddleware({ store, prefilterModel: currentModel });
  let server: Server | null = null;
  let baseUrl = "";

  const listen = (): Promise<void> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        void middleware(req, res, () => {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not api");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

  const closeAll = (): Promise<void> =>
    new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => {
        server = null;
        store.close();
        resolve();
      });
      // undici keep-alive：close(callback) 只停止监听并等连接自然退出（每例 5-10s）。
      // 先关空闲连接，兜底强制断开全部连接，让 teardown 立即完成。
      server.closeIdleConnections();
      server.closeAllConnections();
    });

  await listen();

  return {
    baseUrl,
    dbPath,
    get store() {
      return store;
    },
    async req(method, path, body, headers) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null };
    },
    async restart(restartOpts?: { prefilterModel?: PrefilterModel }) {
      await closeAll();
      if (restartOpts?.prefilterModel !== undefined) currentModel = restartOpts.prefilterModel;
      store = new SqliteProjectStore(dbPath);
      middleware = createApiMiddleware({ store, prefilterModel: currentModel });
      await listen();
    },
    async dispose() {
      await closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RAW_SRT =
  "1\n00:00:01,600 --> 00:00:02,940\n欢迎大家来到创业课\n\n2\n00:00:03,600 --> 00:00:09,460\n今天讲第一个问题\n";

export function makeProjectPayload(
  projectId: string,
  overrides: { name?: string; media?: Record<string, unknown> } = {},
) {
  return {
    meta: {
      projectId,
      name: overrides.name ?? `项目 ${projectId}`,
      normalizedStem: overrides.name ?? `项目 ${projectId}`,
      media: {
        audioName: `${projectId}.mp3`,
        audioSize: 98_320_717,
        audioLastModified: 1_754_400_000_000,
        audioFingerprint: "afp-" + projectId,
        srtFileName: `${projectId}.srt`,
        srtSha256: "deadbeef-" + projectId,
        mediaKey: "key-" + projectId,
        durationMs: null,
        ...overrides.media,
      },
    },
    srtSource: {
      rawContent: RAW_SRT,
      sha256: "srt-sha-" + projectId,
      sourceFilename: `${projectId}.srt`,
      cueCount: 2,
    },
    segments: [
      {
        segmentId: `seg-${projectId}-1`,
        cueNo: 1,
        startMs: 1600,
        endMs: 2940,
        originalText: "欢迎大家来到创业课",
        correctedText: "欢迎大家来到创业课",
        status: "unreviewed",
      },
      {
        segmentId: `seg-${projectId}-2`,
        cueNo: 2,
        startMs: 3600,
        endMs: 9460,
        originalText: "今天讲第一个问题",
        correctedText: "今天讲第一个问题",
        status: "unreviewed",
      },
    ] as Array<{
      segmentId: string;
      cueNo: number | null;
      startMs: number;
      endMs: number;
      originalText: string;
      correctedText: string;
      status: SegmentStatus;
    }>,
    issues: [],
  };
}
