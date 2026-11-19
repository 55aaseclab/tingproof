import type { IncomingMessage } from "node:http";
import type { Stats } from "node:fs";

// Keep static image delivery independent of platform adapters.
export function imageCacheHeaders(info: Stats) {
  const etag = [info.size, info.mtimeMs, info.ctimeMs, info.ino].map(value => value.toString(16)).join("-");
  return {
    "Cache-Control": "private, max-age=3600, must-revalidate",
    ETag: `W/"${etag}"`,
    "Last-Modified": info.mtime.toUTCString(),
    Vary: "Authorization",
  };
}

export function imageNotModified(request: IncomingMessage, headers: ReturnType<typeof imageCacheHeaders>): boolean {
  const candidates = request.headers["if-none-match"];
  if (candidates !== undefined) {
    const value = Array.isArray(candidates) ? candidates.join(",") : candidates;
    const tag = headers.ETag.replace(/^W\//, "");
    return value.trim() === "*" || value.split(",").some(candidate => candidate.trim().replace(/^W\//, "") === tag);
  }
  const modifiedSince = request.headers["if-modified-since"];
  if (typeof modifiedSince !== "string") return false;
  const timestamp = Date.parse(modifiedSince);
  return Number.isFinite(timestamp) && Date.parse(headers["Last-Modified"]) <= timestamp;
}
