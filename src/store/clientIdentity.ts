/**
 * 客户端实例身份（PRD V1.1.1 §4.4.6 二，当前实现范围）：
 * - 持久但非实名：浏览器 localStorage 保存一个随机生成的 client instance ID（`ci-<uuid>`），
 *   跨会话稳定，同一浏览器的不同 profile/无痕窗口通常不同；
 * - 不代表经过认证的人：当前没有账号体系，不伪造真人身份；账号体系后置时再升级署名语义；
 * - localStorage 不可用（隐私模式/非浏览器）时退化为本次进程内的会话 ID，仍诚实可用。
 */
import { randomUuid } from "../core/identity.js";

const STORAGE_KEY = "tingproof.clientInstanceId.v1";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

let cached: string | null = null;

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return typeof s === "object" && s !== null ? s : null;
  } catch {
    return null; // 某些环境直接访问 localStorage 会抛出（如禁用 cookie）
  }
}

/** 读取或生成持久客户端实例 ID；进程内缓存，避免逐请求读 localStorage。 */
export function getClientInstanceId(): string {
  if (cached) return cached;
  const store = storage();
  if (store) {
    try {
      const existing = store.getItem(STORAGE_KEY);
      if (existing && CLIENT_ID_PATTERN.test(existing)) {
        cached = existing;
        return cached;
      }
    } catch {
      // 读取失败：按无既有 ID 处理。
    }
  }
  const generated = `ci-${randomUuid()}`;
  cached = generated;
  if (store) {
    try {
      store.setItem(STORAGE_KEY, generated);
    } catch {
      // 写入失败（隐私模式/容量）：退化为会话内 ID，不冒充持久身份。
    }
  }
  return cached;
}
