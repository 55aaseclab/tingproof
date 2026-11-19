# TingProof managed business API

Contract introduced in requirements V1.1.9 and application 0.1.3.
[简体中文](BUSINESS_API.md)

TingProof implements this API independently. Praxis calls it over HTTP.

## Configuration

- `TINGPROOF_MANAGED=1` enables signed `POST /api/business` and closes the
  legacy `/api/*` routes. Static assets remain accessible. Task guests use
  the restricted platform assignment view.
- `TINGPROOF_BUSINESS_KEY_FILE` points to an app-specific regular file outside
  Git. Supply at least 32 raw bytes and permissions 0600 or 0400. Use the
  bytes as stored, including a trailing newline. Managed startup fails if
  the key is missing.
- `TINGPROOF_LEGACY_SPACE_ID` explicitly binds old single-user projects to
  one space. Unbound projects can receive assignments only there. A request
  cannot claim an unconfigured legacy project. Praxis still checks the
  current user and client.
- Standalone single-user deployments use their existing workflow. Follow
  the platform delivery procedure for a real managed-mode cutover and
  schema migration. Use temporary synthetic databases for development.

## Request and signature

Send `{operation,spaceId,resourceId,input?,expectedRevision?,idempotencyKey?}`.
Unknown fields are rejected. IDs contain 1–80 ASCII letters, digits,
underscores or hyphens. Idempotency keys allow 1–128 characters and may
also contain periods and colons.

Set `x-praxis-assertion` to
`base64url(JSON claims) + '.' + base64url(HMAC-SHA256(payload,key))`. Claims
contain `{v:1,appId:'tingproof',userId,clientId,grantId,spaceId,action,resources,expiresAt,requestId,method:'POST',path:'/api/business',bodyHash}`.
The body hash is a hexadecimal SHA-256 digest of the original HTTP body.
The expiry is in Unix milliseconds, must still be valid and may be at most
30 seconds in the future. The app checks identity fields, action, resources,
space, method, path and body binding. Praxis rechecks user/client grants;
TingProof rechecks assignment revocation and expiry. Keep the signing key
inside the trusted platform adapter and app.

## Operations

| Operation | Action | Resource and input | Response |
| --- | --- | --- | --- |
| `list_assignments` | `read` | `assignments`, omit input or send `{}` | `{assignments:[{id,title,status,revision,expiresAt}],cursor}` for current authorized space/resources. Omits bodies and project IDs. |
| `get_assignment` | `read` | Assignment ID, omit input or send `{}` | `{assignment:{id,spaceId,title,status,expiresAt},revision,cursor,segments:[...]}` containing assigned segments. Project ID, SRT, media, other segments, issues and full audit stay private. |
| `create_assignment` | `assign` | New ID and `{projectId,segmentIds:[...],title?,expiresAt?}`, signed resources must include `*` | Summary, revision, cursor and `replayed`. |
| `submit_corrections` | `submit` | Assignment ID and `{corrections:[{segmentId,correctedText,status?}]}` | Summary, revision, cursor, `replayed` and only submitted segment IDs, corrected text, status and revision numbers. Omits source text. |
| `revoke_assignment` | `assign` | Assignment ID, omit input or send `{}` | Revoked summary, revision, cursor and `replayed`. |
| `events` | `read` | `events` and `{after?:number}` | `{events:[{id,cursor,resourceId,revision,operation,requestId,committedAt}],cursor,minCursor:0}` for current scope. |

Every write requires `expectedRevision` and `idempotencyKey`. Revision
belongs to the original project. Creating or revoking assignments does not
change the project content revision. Corrections reuse existing segment
and confirmation rules. Concurrent assignments on the same project may
conflict. Read back and ask the user which correction to retain.

Supported segment statuses are `unreviewed`, `editing`, `questioned`,
`confirmed` and `accepted_unclear`. Omission preserves the current status.
Confirmation atomically resolves the segment's open issues. Unknown fields,
changes to source text or timing, duplicate or foreign segments, invalid
statuses and stale revisions reject the entire batch.

Business writes, authenticated actor audit, events and idempotent outcomes
commit together. Keys are scoped to user, client and grant. Repeating an
equivalent write returns its original result with `replayed:true`, including
after restart. Reusing a key with different semantics returns 409. A revoked
or expired assignment cannot be read through an old receipt. Revocation
itself is idempotent. Right before the final SQLite COMMIT, the app rechecks
the signature deadline and rolls back all writes with 403 on expiry.

Read events in ascending commit order, at most 100 per response. Continue
from the last returned cursor until a page is empty. Empty pages retain
the supplied cursor. The feed currently has no automatic pruning
(`minCursor:0`). It exposes no private text, raw identity or credential.
Authenticated actor details stay in the protected audit.

## Errors and verification

400 indicates invalid input, 403 failed authorization/signature, 404 an
unavailable assignment, and 409 a revision or idempotency conflict. Responses
omit host paths, raw exceptions and private text. Direct legacy routes,
aliases, SRT, rich audit, prescreening, migration and project deletion are
unavailable in managed mode.

Test with real HTTP and temporary SQLite: assignment isolation, signed
request binding, legacy denial, confirmation, rollback on late failure,
idempotency through restart, revocation, expiry, filtered event paging and
lossless schema-3 upgrade. Record live migration and independent external
agent/phone acceptance separately.
