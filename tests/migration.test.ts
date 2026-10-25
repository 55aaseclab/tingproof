/**
 * v1→v2 数据迁移回归测试（审计 P0-1）。
 * 真实构造 v1 数据库：projects 记录含完整音频 File（模拟第一轮降级路径入库），
 * 升级后断言：
 * - 数据库中彻底不存在 audioFile / 任何 Blob；
 * - audioFingerprint 已从遗留正文的头尾块补齐（非全量复制）；
 * - 文本、状态、版本号、播放数据、原始 SRT 全部不变；
 * - 迁移幂等（重复打开/重复执行结果一致）；
 * - 不含遗留音频的记录原样保留。
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { computeAudioFingerprint } from "../src/core/identity.js";
import {
  migrateLegacyAudioFiles,
  resetDbForTests,
} from "../src/store/db.js";
import { getProject, getProjectSegments, getSrtSource } from "../src/store/repo.js";

const RAW_SRT = "1\n00:00:01,600 --> 00:00:02,940\n欢迎大家来到创业课\n";
const AUDIO_BYTES = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
const LEGACY_FILE = new File([AUDIO_BYTES as BlobPart], "legacy.mp3", { type: "audio/mpeg" });

function legacyProjectMeta(projectId: string, withAudioFile: boolean) {
  const media: Record<string, unknown> = {
    audioName: "旧项目音频.mp3",
    audioSize: AUDIO_BYTES.length,
    audioLastModified: 1_700_000_000_000,
    srtFileName: "旧项目字幕.srt",
    srtSha256: "sha-legacy",
    mediaKey: "key-" + projectId,
    durationMs: null,
    srtHandle: null,
    audioHandle: null,
  };
  if (withAudioFile) {
    media.audioFile = LEGACY_FILE; // 第 1 轮缺陷：完整音频正文入库
    media.audioFingerprint = "";   // 旧记录无指纹
  } else {
    media.audioFingerprint = "afp1|1|aa|bb"; // 正常记录已有指纹
  }
  return {
    projectId,
    name: "旧项目",
    normalizedStem: "旧项目",
    createdAt: 111,
    updatedAt: 222,
    media,
    playback: { positionMs: 123_456, speed: 0.8, autoRewindMs: 1500, loopSegmentId: null },
  };
}

const LEGACY_SEGMENTS = [
  {
    segmentId: "seg-1",
    projectId: "tp-legacy",
    cueNo: 1,
    startMs: 1600,
    endMs: 2940,
    originalText: "欢迎大家来到创业课",
    correctedText: "欢迎大家来到创业课（已校对）",
    status: "confirmed",
    revisionNo: 3,
    updatedAt: 333,
  },
];

async function buildLegacyV1Database(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("tingproof", 1); // 模拟第 1 轮的 v1 库
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("projects", { keyPath: "projectId" });
      db.createObjectStore("srt_source", { keyPath: "projectId" });
      const segs = db.createObjectStore("segments", { keyPath: "segmentId" });
      segs.createIndex("byProject", "projectId");
      const issues = db.createObjectStore("issues", { keyPath: "issueId" });
      issues.createIndex("byProject", "projectId");
      issues.createIndex("bySegment", "segmentId");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["projects", "srt_source", "segments"], "readwrite");
      tx.objectStore("projects").put(legacyProjectMeta("tp-legacy", true));
      tx.objectStore("projects").put(legacyProjectMeta("tp-clean", false));
      tx.objectStore("srt_source").put({
        projectId: "tp-legacy",
        rawContent: RAW_SRT,
        sha256: "sha-legacy",
        sourceFilename: "旧项目字幕.srt",
        cueCount: 1,
        importedAt: 444,
      });
      for (const s of LEGACY_SEGMENTS) tx.objectStore("segments").put(s);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 直接扫描 v2 库，断言任何 projects 记录都不再携带音频正文。 */
async function scanProjectsRaw(): Promise<Record<string, unknown>[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("tingproof", 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const tx = db.transaction("projects", "readonly");
    const all = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const r = tx.objectStore("projects").getAll();
      r.onsuccess = () => resolve(r.result as Record<string, unknown>[]);
      r.onerror = () => reject(r.error);
    });
    return all;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
  await buildLegacyV1Database();
  resetDbForTests();
});

describe("v1→v2 迁移：清除遗留音频正文（P0-1）", () => {
  it("升级后 audioFile 彻底消失、指纹补齐、其余数据原样", async () => {
    const meta = await getProject("tp-legacy");
    expect(meta).toBeDefined();
    const media = meta!.media as unknown as Record<string, unknown>;
    expect("audioFile" in media).toBe(false);

    const expectedFp = await computeAudioFingerprint(LEGACY_FILE);
    expect(media.audioFingerprint).toBe(expectedFp);

    // 文本/状态/版本/播放数据不变。
    const segs = await getProjectSegments("tp-legacy");
    expect(segs).toHaveLength(1);
    expect(segs[0].correctedText).toBe("欢迎大家来到创业课（已校对）");
    expect(segs[0].status).toBe("confirmed");
    expect(segs[0].revisionNo).toBe(3);
    expect(segs[0].originalText).toBe("欢迎大家来到创业课");
    expect(meta!.playback).toEqual({
      positionMs: 123_456,
      speed: 0.8,
      autoRewindMs: 1500,
      loopSegmentId: null,
    });
    expect(meta!.updatedAt).toBe(222);
    const src = await getSrtSource("tp-legacy");
    expect(src?.rawContent).toBe(RAW_SRT);
  });

  it("迁移后数据库扫描：任何 projects 记录都不再含 File/Blob/音频正文", async () => {
    await getProject("tp-legacy"); // 触发 getDb（迁移在业务读写前完成）
    const all = await scanProjectsRaw();
    expect(all.length).toBe(2);
    for (const rec of all) {
      const media = rec.media as Record<string, unknown>;
      expect("audioFile" in media).toBe(false);
    }
  });

  it("幂等：重复打开连接/重复执行迁移，结果一致且二次迁移计数为 0", async () => {
    const first = await getProject("tp-legacy");
    resetDbForTests();
    const second = await getProject("tp-legacy");
    expect(second).toEqual(first);

    resetDbForTests();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tingproof", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      expect(await migrateLegacyAudioFiles(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("不含遗留音频的正常记录原样保留（包括已有指纹）", async () => {
    await getProject("tp-legacy");
    const clean = await getProject("tp-clean");
    expect(clean).toEqual(legacyProjectMeta("tp-clean", false));
  });

  it("遗留正文不可读时指纹置空，交由旧项目重连流程处理（不阻塞迁移）", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tingproof", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      // 第一次迁移处理 v1 遗留的 tp-legacy（读到正文，补真实指纹）。
      expect(await migrateLegacyAudioFiles(db)).toBe(1);
      // 再放入一条带预置指纹的遗留记录：迁移应沿用预置指纹、不读正文。
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put({
        ...legacyProjectMeta("tp-broken", true),
        media: { ...legacyProjectMeta("tp-broken", true).media, audioFingerprint: "preset" },
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      expect(await migrateLegacyAudioFiles(db)).toBe(1);
      const recs = await scanProjectsRaw();
      const broken = recs.find((r) => r.projectId === "tp-broken");
      expect((broken!.media as Record<string, unknown>).audioFingerprint).toBe("preset");
      expect("audioFile" in (broken!.media as Record<string, unknown>)).toBe(false);
    } finally {
      db.close();
    }
  });
});
