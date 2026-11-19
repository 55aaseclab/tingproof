# TingProof roadmap

Requirements V1.1.12 · [English PRD](docs/PRD.en.md) · [简体中文](ROADMAP.md)

## V1.1.11 · Interface languages

Ship English and Simplified Chinese across import, playback, corrections,
issue review and export. Verify the default language, switching without
losing edits, persistence and the original language of source subtitles and
reviewer notes. Release 0.1.5 includes the native language control. The
managed assignment interface follows the workbench preference.

## V1.1.10 · Leaving with unsaved edits

Update PRD and roadmap, bind exit protection to pending saves, failed saves
and active IME composition, then exercise synthetic navigation events and the
save coordinator before committing application 0.1.4. Prompt only while
edits require protection. A successful save restores normal navigation.

Verification included eight targeted exit/navigation checks, 438 passing
tests, six existing external-fixture skips, lint, TypeScript and the
`/apps/tingproof/` build. Tests used isolated data.

## V1.1.9 · Final deadline check

Check the signed request's expiry after business and metadata writes and
immediately before SQLite COMMIT. A synthetic clock verifies HTTP 403 and
atomic rollback when the deadline passes inside the transaction. The
application moves to 0.1.3 and keeps schema 4.

AC-077 passed with 14 synthetic API tests, 435 passing tests and six
external-fixture skips. Lint, typecheck and the prefixed build passed.

## V1.1.8 · Scoped assignments

Update requirements, plan and signed API before implementing the schema,
audit and events. Release the independently tested 0.1.2 package.

| Stage | Deliverable and acceptance |
| --- | --- |
| T1. Request boundary | HMAC binds a short-lived assertion to one request. Missing key stops managed startup. Legacy API routes reject requests. |
| T2. Assignment data | Schema 4 adds assignment tables. Bind the project to a space, assign explicit segments, support expiry and revocation, and preserve the original project. |
| T3. Corrections | Reuse correction and confirmation semantics. Handle batch writes, revision conflicts, durable idempotency and authenticated audit in one transaction. |
| T4. Isolation | Pass AC-075/076, the regression suite and the prefixed build. Independently verify external agents and phones through the platform. |

Allow 20% contingency for authorization, compatibility and recovery. Guests
use the restricted assignment screen. Praxis reevaluates membership and
client access for each call; TingProof verifies the signature and current
assignment state and expiry.

Evidence: 13 new synthetic business tests, 434 passing tests, six conditional
external-fixture skips and the prefixed production build. Real database
migration, production rollout and independently authenticated agent/phone
acceptance are separate operations. [Managed business API](docs/BUSINESS_API.en.md)

## V1.1.5–V1.1.6 · Hosting and origin checks

| Version | Requirement | Acceptance |
| --- | --- | --- |
| V1.1.5 | HTTPS `/apps/tingproof/` entry, AC-072 | Derive the browser API base from Vite `BASE_URL`. Test the actual request path at the prefix, local root, explicit API URL and non-browser fallback. Run the suite and prefixed build. |
| V1.1.6 | Deployment hostname access, AC-073 | Allow the two designated deployment hostnames in dev and preview. Use synthetic data and HTTP Host tests for those names, localhost and IP access. Unknown hosts receive 403. Verify the running entry after restart. |

Build the managed distribution with
`npm run build -- --base /apps/tingproof/ --outDir dist-public`. The gateway
strips the prefix, and the standalone API uses `/api`. Praxis owns deployment
and public entry acceptance.

## V1.1.7 · Static image caching

Update the plan, identify image responses, apply private cache validation
and conditional GET/HEAD, test temporary resources and build the production
client. Increment package and lock to 0.1.1. Cache successful ordinary
static images for an hour with validators. HTML/SPA fallback, API, audio
and errors retain their own policies.

AC-074 requires 304 for a valid conditional request, a fresh file after
replacement, intact account boundaries and no record changes. Reserve 20%
for fixes. Verify the deployment headers on the running gateway. Four
synthetic HTTP cases and the full 421-test suite passed, with six external
fixture checks skipped. Follow-up checks covered HTML symlinks disguised
as images (HTML MIME and no-store) and rejection of GET/HEAD of symlinks
outside the static root. Seven focused checks and 421 regressions passed.

## Interaction review

Test two subtitle reads returning out of order and verify that the latest
selection wins. Retry a failed recent-project list into a confirmed empty
state. Exercise delayed saves, failures and access changes in the managed
assignment view. Preserve the active draft and project title, and retry
both first connection and partial assignment-list failures.

## Built-in distribution

Publish the native application and its scoped data API as a pinned Praxis app. A fresh installation starts with empty private storage. Public source and synthetic tests ship independently of host configuration and records.

## Praxis provider / 工作台供数

Publish the app-owned card and data-source contract. Verify synthetic authorized records, native links, stable revisions, empty/error separation and metadata resolution. Keep storage keys, business records and video provisioning outside this module.

发布由应用维护的卡片与数据源合同，使用合成授权记录验证原生入口、稳定版本、空态与错误区分及元数据解析。供数模块不接触密钥、真实业务记录或视频引擎安装。

## Native assignment links / 原生任务链接

Verify exact assignment scope, original/corrected text, timings, local-only audio, lost-access clearing and no whole-project request or write.

验收准确任务范围、原文与校正稿、时间、本机录音、失权清空，以及无整项目请求和业务写入。

## V1.1.12 · Scoped native corrections

Verify assignment-only entry and compiled assets, denial of whole-project APIs, read-only default without a submit hint, authorized typed saves with revision/idempotency and actual readback, conflict draft comparison, exact retry after an uncertain save and loss-of-access clearing. Preserve the native renderer and local-only audio boundaries.
