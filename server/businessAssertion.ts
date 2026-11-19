import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { HttpApiError } from "./errors.ts";

export const BUSINESS_ACTIONS = {
  get_assignment: "read",
  submit_corrections: "submit",
  create_assignment: "assign",
  revoke_assignment: "assign",
  events: "read",
  list_assignments: "read",
} as const;

export interface BusinessRequest {
  operation: keyof typeof BUSINESS_ACTIONS;
  spaceId: string;
  resourceId: string;
  input?: Record<string, unknown>;
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface BusinessClaims {
  v: 1;
  appId: "tingproof";
  userId: string;
  clientId: string;
  grantId: string;
  spaceId: string;
  action: string;
  resources: string[];
  expiresAt: number;
  requestId: string;
  method: "POST";
  path: "/api/business";
  bodyHash: string;
}

export interface BusinessSecurityOptions {
  managed?: boolean;
  key?: Buffer;
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const denied = () => new HttpApiError(403, "forbidden", "Business access denied.");

export function businessSecurity(options: BusinessSecurityOptions = {}): Required<Pick<BusinessSecurityOptions, "managed">> & Pick<BusinessSecurityOptions, "key"> {
  const managed = options.managed ?? process.env.TINGPROOF_MANAGED === "1";
  let key = options.key;
  const file = process.env.TINGPROOF_BUSINESS_KEY_FILE;
  if (!key && file) {
    const info = lstatSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) {
      throw new Error("Business key must be a private regular file.");
    }
    key = readFileSync(file);
  }
  if (key && (key.length < 32 || key.length > 4096)) throw new Error("Business key must contain 32 to 4096 bytes.");
  if (managed && !key) throw new Error("Managed TingProof requires a business signing key.");
  return { managed, key };
}

export function parseBusinessRequest(value: unknown): BusinessRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpApiError(400, "bad_request", "Expected a business request object.");
  }
  const body = value as Record<string, unknown>;
  const allowed = ["operation", "spaceId", "resourceId", "input", "expectedRevision", "idempotencyKey"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.operation !== "string" || !Object.hasOwn(BUSINESS_ACTIONS, body.operation) ||
      typeof body.spaceId !== "string" || !ID.test(body.spaceId) ||
      typeof body.resourceId !== "string" || !ID.test(body.resourceId) ||
      (body.input !== undefined && (!body.input || typeof body.input !== "object" || Array.isArray(body.input))) ||
      (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) ||
      (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.idempotencyKey)))) {
    throw new HttpApiError(400, "bad_request", "Invalid business request fields.");
  }
  if (!["get_assignment", "events", "list_assignments"].includes(String(body.operation)) && !body.idempotencyKey) {
    throw new HttpApiError(400, "bad_request", "A write requires an idempotency key.");
  }
  if (body.operation === "get_assignment" && (body.expectedRevision !== undefined || body.idempotencyKey !== undefined || Object.keys(body.input ?? {}).length > 0)) {
    throw new HttpApiError(400, "bad_request", "Assignment reads do not accept mutation fields.");
  }
  if (body.operation === "events" && (body.resourceId !== "events" || body.expectedRevision !== undefined || body.idempotencyKey !== undefined)) {
    throw new HttpApiError(400, "bad_request", "Invalid event request fields.");
  }
  if (body.operation === "list_assignments" && (body.resourceId !== "assignments" || body.expectedRevision !== undefined || body.idempotencyKey !== undefined || Object.keys(body.input ?? {}).length > 0)) {
    throw new HttpApiError(400, "bad_request", "Invalid assignment list fields.");
  }
  return body as unknown as BusinessRequest;
}

export function verifyBusinessAssertion(req: IncomingMessage, raw: string, body: BusinessRequest, key: Buffer | undefined, now = Date.now()): BusinessClaims {
  if (!key) throw new HttpApiError(503, "business_unavailable", "Business integration is not configured.");
  const header = req.headers["x-praxis-assertion"];
  if (typeof header !== "string" || header.length > 16_384) throw denied();
  const [payload, signature, extra] = header.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw denied();
  const expected = createHmac("sha256", key).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw denied();
  let claims: BusinessClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BusinessClaims; }
  catch { throw denied(); }
  if (!claims || claims.v !== 1 || claims.appId !== "tingproof" ||
      ![claims.userId, claims.clientId, claims.grantId, claims.spaceId, claims.requestId].every((id) => typeof id === "string" && ID.test(id)) ||
      claims.method !== "POST" || req.method !== "POST" || claims.path !== "/api/business" || req.url !== "/api/business" ||
      claims.spaceId !== body.spaceId || claims.action !== BUSINESS_ACTIONS[body.operation] ||
      !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > now + 30_000 ||
      !Array.isArray(claims.resources) || claims.resources.length < 1 || claims.resources.length > 1000 ||
      !claims.resources.every((resource) => resource === "*" || (typeof resource === "string" && ID.test(resource))) ||
      (!["events", "list_assignments"].includes(body.operation) && !(claims.resources.includes("*") || claims.resources.includes(body.resourceId))) ||
      (body.operation === "create_assignment" && !claims.resources.includes("*")) ||
      claims.bodyHash !== createHash("sha256").update(raw).digest("hex")) throw denied();
  return claims;
}
