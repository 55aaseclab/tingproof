/**
 * IndexedDB 薄封装 + v1→v2 数据迁移。
 *
 * 迁移目标（审计 P0-1）：第 1 轮样机曾把完整音频 File/Blob 存进 project.media.audioFile。
 * v2 迁移在 list/get 任何项目之前执行：
 * 1. 扫描旧 projects 记录，凡 media.audioFile 为 Blob/File：
 *    - 若缺 audioFingerprint，只读取首尾各 64KB 计算指纹（不全量复制音频）；
 *    - 读取失败则指纹记为 ""（后续由旧项目重连流程 decideRelocate 处理）；
 *    - 写回移除 audioFile 的纯元数据对象；
 * 2. 迁移幂等：不含 audioFile 的记录原样跳过，可重复执行；
 * 3. 迁移完成后数据库内不再存在任何 File/Blob/音频正文（有回归测试扫描验证）。
 */

import { computeAudioFingerprint } from "../core/identity.js";

const DB_NAME = "tingproof";
const DB_VERSION = 2;

export const STORE_PROJECTS = "projects";
export const STORE_SRT_SOURCE = "srt_source";
export const STORE_SEGMENTS = "segments";
export const STORE_ISSUES = "issues";

let dbPromise: Promise<IDBDatabase> | null = null;

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: "projectId" });
      }
      if (!db.objectStoreNames.contains(STORE_SRT_SOURCE)) {
        db.createObjectStore(STORE_SRT_SOURCE, { keyPath: "projectId" });
      }
      if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
        const store = db.createObjectStore(STORE_SEGMENTS, { keyPath: "segmentId" });
        store.createIndex("byProject", "projectId");
      }
      if (!db.objectStoreNames.contains(STORE_ISSUES)) {
        const store = db.createObjectStore(STORE_ISSUES, { keyPath: "issueId" });
        store.createIndex("byProject", "projectId");
        store.createIndex("bySegment", "segmentId");
      }
      // 结构在 v1 已完整；v2 仅做数据清理（见 migrateLegacyAudioFiles）。
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
    req.onblocked = () => reject(new Error("IndexedDB 被其他标签页占用"));
  });
}

function isBlobLike(v: unknown): v is Blob {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Blob).slice === "function" &&
    typeof (v as Blob).size === "number"
  );
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

/** 判断记录是否为“含遗留音频正文的 v1 项目”。 */
export function hasLegacyAudioFile(meta: unknown): boolean {
  const media = (meta as { media?: Record<string, unknown> } | null | undefined)?.media;
  return !!media && isBlobLike(media.audioFile);
}

/**
 * v1→v2 数据迁移。幂等；在任何业务读写之前调用。
 * 单条计算/写回失败不阻塞其他记录；音频正文读取失败时指纹置空字符串，
 * 交给旧项目重连流程（decideRelocate）按文件名+大小确认建立身份。
 */
export async function migrateLegacyAudioFiles(db: IDBDatabase): Promise<number> {
  // 第一遍：只读收集含遗留音频的记录。
  const candidates: Record<string, unknown>[] = [];
  {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const store = tx.objectStore(STORE_PROJECTS);
    const allReq = store.getAll();
    const all: unknown[] = await new Promise((resolve, reject) => {
      allReq.onsuccess = () => resolve(allReq.result as unknown[]);
      allReq.onerror = () => reject(allReq.error ?? new Error("读取项目失败"));
    });
    for (const rec of all) {
      if (hasLegacyAudioFile(rec)) candidates.push(rec as Record<string, unknown>);
    }
  }
  if (candidates.length === 0) return 0;

  // 计算指纹（事务外，允许异步读取 Blob 首尾块）。
  const cleaned: Record<string, unknown>[] = [];
  for (const rec of candidates) {
    const media = { ...(rec.media as Record<string, unknown>) };
    const blob = media.audioFile as Blob;
    let fingerprint = typeof media.audioFingerprint === "string" ? media.audioFingerprint : "";
    if (!fingerprint) {
      try {
        fingerprint = await computeAudioFingerprint(blob);
      } catch {
        fingerprint = "";
      }
    }
    delete media.audioFile; // 唯一目标：数据库中不再存在音频正文
    media.audioFingerprint = fingerprint;
    cleaned.push({ ...rec, media });
  }

  // 第二遍：写回纯元数据。
  const tx = db.transaction(STORE_PROJECTS, "readwrite");
  const store = tx.objectStore(STORE_PROJECTS);
  for (const rec of cleaned) store.put(rec);
  await txDone(tx);
  return cleaned.length;
}

async function openDatabase(): Promise<IDBDatabase> {
  const db = await openRaw();
  await migrateLegacyAudioFiles(db);
  return db;
}

export function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDatabase();
  return dbPromise;
}

export async function withStore<T>(
  names: string | string[],
  mode: IDBTransactionMode,
  fn: (stores: Record<string, IDBObjectStore>) => IDBRequest<T> | void,
): Promise<T> {
  const db = await getDb();
  const storeNames = Array.isArray(names) ? names : [names];
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of storeNames) stores[name] = tx.objectStore(name);
    let request: IDBRequest<T> | void;
    try {
      request = fn(stores);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    tx.oncomplete = () => {
      resolve(request && "result" in request ? request.result : (undefined as T));
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

/** 仅供测试：丢弃缓存的连接，模拟“关闭应用后重新打开”。 */
export function resetDbForTests(): void {
  dbPromise = null;
}
