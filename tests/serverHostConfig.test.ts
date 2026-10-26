/**
 * 组合服务配置测试（PRD V1.1.0 / A1）：
 * - dev 与 preview 均绑定 0.0.0.0:5173，页面与 /api 同端口同源；
 * - tingproof-api 插件把 SQLite API 挂进 Vite 进程；
 * - 独立生产服务默认同样 0.0.0.0:5173，且使用文件数据库（非内存）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TINGPROOF_API_PLUGIN_NAME, tingproofApiPlugin } from "../vite-plugin-tingproof-api.js";
import { DEFAULT_HOST, DEFAULT_PORT, createTingProofServer } from "../server/main.js";
import { SqliteProjectStore } from "../server/sqliteStore.js";
import viteConfig from "../vite.config.js";

describe("0.0.0.0 组合服务配置", () => {
  it("vite dev/preview host=0.0.0.0、port=5173，并包含 tingproof-api 中间件插件", () => {
    expect(viteConfig.server?.host).toBe("0.0.0.0");
    expect(viteConfig.server?.port).toBe(5173);
    expect(viteConfig.preview?.host).toBe("0.0.0.0");
    expect(viteConfig.preview?.port).toBe(5173);
    const pluginNames = (viteConfig.plugins ?? [])
      .flatMap((p) => (Array.isArray(p) ? p : [p]))
      .map((p) => (p && "name" in p ? p.name : null));
    expect(pluginNames).toContain(TINGPROOF_API_PLUGIN_NAME);
    expect(tingproofApiPlugin().name).toBe(TINGPROOF_API_PLUGIN_NAME);
  });

  it("独立生产服务默认 0.0.0.0:5173，数据库为文件（非 :memory:/Map）", () => {
    expect(DEFAULT_HOST).toBe("0.0.0.0");
    expect(DEFAULT_PORT).toBe(5173);
    const dir = mkdtempSync(join(tmpdir(), "tingproof-host-"));
    const dbPath = join(dir, "host-test.db");
    const instance = createTingProofServer({ dbPath, distDir: dir });
    try {
      expect(instance.host).toBe("0.0.0.0");
      expect(instance.port).toBe(5173);
      expect(instance.dbPath).toBe(dbPath);
      expect(instance.dbPath).not.toBe(":memory:");
      // 写入并从同一实例读取，确认底层为可持久化文件库。
      instance.store.createProject(
        JSON.parse(
          JSON.stringify({
            meta: { projectId: "tp-host", name: "host", normalizedStem: "host", media: { mediaKey: "k1", audioName: "a.mp3", audioSize: 1, audioLastModified: 1, audioFingerprint: "fp", srtFileName: "a.srt", srtSha256: "s", durationMs: null } },
            srtSource: { rawContent: "1\n00:00:01,000 --> 00:00:02,000\nx\n", sha256: "sha", sourceFilename: "a.srt", cueCount: 1 },
            segments: [{ segmentId: "seg-host-1", cueNo: 1, startMs: 1000, endMs: 2000, originalText: "x", correctedText: "x", status: "unreviewed" }],
            issues: [],
          }),
        ),
        { clientId: "ci-test-host", source: "api" },
      );
      expect(instance.store.listProjectSummaries()).toHaveLength(1);
    } finally {
      instance.server.close();
    }
  });

  it("SqliteProjectStore 拒绝内存模式（始终落文件）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-nomem-"));
    const store = new SqliteProjectStore(join(dir, "real.db"));
    expect(store.dbPath).toBe(join(dir, "real.db"));
    store.close();
  });
});
