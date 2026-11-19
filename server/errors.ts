/** 服务端 API 错误：由 apiHandler 统一映射为 HTTP 响应（PRD 4.4.4）。 */

export class HttpApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function notFound(message = "资源不存在"): HttpApiError {
  return new HttpApiError(404, "not_found", message);
}

export function badRequest(message: string, extra: Record<string, unknown> = {}): HttpApiError {
  return new HttpApiError(400, "bad_request", message, extra);
}

export function payloadTooLarge(limitBytes: number): HttpApiError {
  return new HttpApiError(413, "payload_too_large", `请求体超过 ${limitBytes} 字节上限`);
}

/** 版本冲突：缺少或不匹配 expectedRevision（PRD 4.4.4 写入约定 2）。 */
export function conflict(
  message: string,
  extra: { currentRevision?: number; [k: string]: unknown } = {},
): HttpApiError {
  return new HttpApiError(409, "revision_conflict", message, extra);
}

export function sourceConflict(
  message: string,
  extra: Record<string, unknown> = {},
): HttpApiError {
  return new HttpApiError(409, "source_conflict", message, extra);
}
