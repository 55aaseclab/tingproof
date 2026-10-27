# 听校（TingProof）V0.1 纵向样机（第 9 轮：V1.1.4 真实标注反馈与文本预筛）

由服务端项目空间承载、可从多个设备访问的长音频人工听校工作台——最小完整闭环：

> 导入 MP3 + SRT → 边听边校（播放 / 变速 / 自动回退 / 循环）→ 自动保存与恢复 → 标记疑点 → 导出 SRT 并回读校验。

对应 [`docs/听校_PRD_V1.0.0.md`](docs/听校_PRD_V1.0.0.md) 的 V0.1 范围（PRD 2.4：单文件纵向样机；当前文档版本 V1.1.4）。

产品文档均随独立仓库保存在 `docs/`：

- [产品需求文档（PRD，当前 V1.1.4）](docs/听校_PRD_V1.0.0.md)
- [待确认项清单](docs/听校_待确认项清单_V1.0.0.md)
- [Q4 版本路线图](docs/1025-Q4路线图.html)

第 3–9 轮审计已全部完成并纳入本版，要点：

- **第 3 轮（数据与行为）**：v1→v2 数据迁移（清除遗留音频正文并补指纹）、保存协调器丢写修复、导航/重定位前强制落盘、播放速率真实恢复、暂停即时持久化、旧项目音频重连策略、界面纯白底；
- **第 4 轮（并发与依赖）**：SaveCoordinator 并发 flush 改为 join 语义、播放→选中订阅只依赖稳定引用（纯 render 不覆盖显式选中）、周期持久化计时器不随 render 重置；
- **第 5 轮（真实浏览器布局验收）**：≤1100px/900×900 下列表与疑点栏上下分区、互不重叠、各自独立滚动；内联 data URI favicon 消除 /favicon.ico 404；
- **第 6 轮（ground-truth 富审计，PRD V1.1.1）**：服务端 `audit_events` 升级为可还原人工标注过程的追加式富审计日志——结构化 before/after/changedFields/metadata、疑点与字幕段动作分类、持久非实名客户端来源、只读分页查询 API、旧 SQLite 库原地幂等迁移（PRAGMA user_version schema 版本）；本轮不做审计 UI，接口与数据库即为 ground-truth 导出通道（AC-058 至 AC-065）；
- **第 7 轮（主审计复验修正，PRD V1.1.2）**：钉死富审计契约的精确语义并补对抗/探针回归——语义 no-op 不写对象/不增长 revision/不产生事件（含 media 分阶段补丁净 no-op，changedFields 按最终前后值一次性计算且绝不重复）、疑点 after 与返回值取数据库 canonical 行、createdAt 创建后不可变、issue_id 全局主键隔离（跨项目写入 404；导入碰撞与同一载荷内重复 issueId 均整体回滚，create_project 快照 issueCount 与主表一致）、schema 版本只进不退（未来版本拒绝打开）、数据库 open 后任意初始化失败统一释放句柄后原样重抛、损坏的非 NULL 审计 JSON 查询明确失败。
- **第 8 轮（删除历史记录，PRD V1.1.3 / AC-066）**：导入页最近项目每条在「打开」旁新增「删除」按钮（danger 样式，白底不变）；行内二次确认（文案明确不可撤销且不删本机 MP3/SRT 源文件），确认后经服务端 `deleteProject` 在同一事务删除项目行、SRT、segments、issues、播放进度与预筛数据，条目从所有访问同一服务的设备消失；删除期间仅目标条目禁用、删到 0 条显示空状态；失败保留可重试——409 版本冲突只安全刷新 revision（绝不自动重试删除），由用户再次点击「删除」并二次确认后以最新版本删除；迟到的旧列表响应不得复活已删除条目（请求代次 + 删除失效保护）；`delete_project` 审计行按 V1.1.2 契约长期保留，不新增审计删除接口。
- **第 9 轮（V1.1.4 真实标注反馈与文本预筛，AC-067 至 AC-071）**：一、编辑打断精确续播——当前段播放中聚焦其文本框只在精确打断位置暂停（不回段首），下一次播放从该点无回退续播，标记一次性消费（play 成功起播后消费、reject 保留重试；seek/±2s/换段/段尾/循环/时间轴变化清除；行空白区点击仍是精确定位段首，两语义分离）；二、原子确认——行内确认与 Ctrl+Enter 一次服务端事务确认段（含 pending 草稿）并解决本段全部 open 疑点，revision 只增长一次，审计为 confirm_segment + 稳定顺序 resolve_issue（共享 revision/时间，metadata.cause=segment_confirm），撤销不重开，任一子写失败整体回滚；三、机器文本可疑点预筛——服务端只读不可变 originalText（绝不发送音频/correctedText），OpenAI-compatible 服务端环境配置（`TINGPROOF_LLM_BASE_URL/MODEL/API_KEY`，密钥绝不回传浏览器/入库/入日志），严格结构化输出白名单校验（未知顶层/未知字段/未知 ID/非原文子串/非法类型/超长/单段第 4 条/批内重复全部拒绝并计数、持久化 rejected 行），合法候选落为 warning 级 `machine_prefilter` 疑点（机器来源/置信度/可疑片段/建议/理由可见，不自动改稿不自动确认），批次原子认领（并发只调一次模型）、inputHash 幂等复用、失败续跑/重试/取消、服务重启恢复、已删除/已解决候选不复活不重开、冻结后已确认段不产生 open 机器疑点，审计 source=machine_prefilter 且 metadata 完整脱敏，模型未配置/失败时人工链路完全可用；四、第 9-10 轮复审并发收尾——疑点刷新并发协调重做为独立协调器（per-mutation pending token、confirm 原子结果不覆盖更晚的本地 pending mutation 且非永久保护、合并决策同步冻结、跨设备删除同步、journal 无泄漏清理），预筛 latest 错误恢复与 cancel 后迟到批次只读同步最终计数（cancel 响应两种到达顺序均恰好一次 latest、不轮询、不覆盖新 run、旧迟到不清新错误），Ctrl+Enter 与行内确认的在途竞态以真实键盘/deferred 时序锁定。

逐轮明细与测试证据见 §5。

---

## 1. 环境要求

- Node.js ≥ 22.13（服务端使用内置 `node:sqlite`；本轮由主审计在 Node 24.22.1 复验）
- Chromium 系浏览器：**Chrome / Edge / Chromium**（File System Access API：音频句柄持久化、导出回读、源文件保护；Firefox/Safari 功能可用但会退级，见 §7）
- 服务端为项目与进度事实源；不同设备通过同一服务地址访问同一项目空间，浏览器本地数据只作缓存/迁移来源（音频仍可由各设备本地选择）
- 界面为白色/浅色主题，状态以「颜色 + 图标 + 文字」三重表达。窄屏（≤1100px）：列表与疑点栏改为上下分区——字幕列表独立滚动，疑点栏固定可见在列表下方（限高 45%）并自带滚动，两区互不重叠（900×900 验收无横向溢出、无叠压）；favicon 为内联 SVG data URI，无网络请求。

## 2. 安装 / 运行 / 测试 / 构建

```bash
cd third_party/YOUGETANAME/tingproof
npm install          # 安装依赖（一次性，需要网络）
npm run dev          # 页面 + /api 组合开发服务，监听 0.0.0.0:5173
npm run lint         # tsc --noEmit + eslint
npm test             # vitest 全部自动测试
npm run build        # 类型检查 + 产线构建到 dist/
npm run preview      # 页面 + /api 组合预览服务，监听 0.0.0.0:5173
npm run serve        # 独立生产服务（先 build），静态 dist + /api，监听 0.0.0.0:5173
```

三个服务命令都把页面和 `/api` 放在同一端口，并使用仓库内 `data/tingproof.db` 作为共享事实源。局域网设备访问 `http://<服务主机局域网 IP>:5173/`，即可看到同一份项目列表和进度。不要同时启动这些命令，也不要用 `file://` 直接打开 `dist/index.html`。

### 本轮已自动化验证的结果（2026-10-26，主审计复验环境 Node 24.22.1）

以下 `npm run lint`（tsc + eslint）、`npm run build` 均由主审计在 Node 24.22.1 实际复验通过（当时基线 32 文件 283 用例；当前门禁数字见下方测试表）：

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | 通过（无空白错误） |
| `npm run lint`（tsc + eslint） | 通过，0 错误 |
| `npm test` | 44 个文件 **415 个用例全部通过**（含既有播放/编辑/疑点/确认/滚动/删除回归，ground-truth 富审计全套，以及本轮 V1.1.4：编辑打断精确续播（播放器 10 例 + Workbench 接线 3 例，含 play reject 保留/ended 清理/语义分离）、原子确认（服务端 7 例含 SQL trigger 注入回滚 + idbRepo 3 例 + Workbench 8 例 + 失败路径 1 例 + 保存保护 1 例 + 队列项身份 3 例 + 快照跳过 2 例 + deferred 竞态 3 例：行内 advance:false 与 Ctrl+Enter advance:true 双路径精确保存 T2/不前进/不确认 + flush 快照跳过）、文本预筛（服务端 34 例：输入/校验/幂等/恢复/并发 claim/取消竞态/审计脱敏/迁移中间态/适配器重试，客户端 UI 23 例 + deferred 竞态 10 例：降级/循环/重试/取消/机器建议展示/latest 错误恢复 2 例/取消后迟到批次同步 3 例含 cancel 响应反序）、疑点刷新并发协调（协调器单测 11 例 + 真实 deferred 竞态 9 例：双 GET 并发反序/pending 中 create-resolve-delete 各自等待保存真正成功/保存 pending 保护/旧 ack 不清新 mutation/confirm 保护与非永久 pending/confirm 在途本地删除在保存失败时不被服务端旧行复活/跨设备删除）） |
| `npm run build` | 成功 |
| 组合服务 | `0.0.0.0:5173` 监听通过；页面与 `/api/projects` 经 localhost 和局域网地址均返回 HTTP 200 |

### 本次主审计已完成的真实浏览器验证（第 5 轮，真实 Chrome 153）

以下为**主审计方**在真实浏览器中完成并出具的验收结果，非本仓库自动化测试：

- 900×900 窄屏布局：`document.body` 900/900 无横向溢出；bounding boxes 满足 list.bottom = side.top、side.bottom = player.top，无区域重叠；字幕列表独立滚动时 side/main/window 不动；临时扩充疑点后 issue-list 可独立滚动；
- 页面白底 `rgb(255,255,255)`；
- `network/console problems` 均为 0（内联 data URI favicon 已消除 /favicon.ico 404）；
- 旧 profile 迁移后物理回收：IndexedDB 磁盘占用约 96MB → 2.3MB，重启同 profile 后 `navigator.storage.estimate().usage = 2,287,929` bytes，DB v2 保留 1,676 段与原始 SRT，无 `media.audioFile` 或任何 Blob 正文。

### 尚未自动化、需要按 §3 人工验证的能力

真实 <audio> 元素的端到端听感（逐段播放的段尾 100ms 口径在真实音频下由 AC-043 主审计方抽验）、
变速不变调听感、拖动时间轴、输入法组合输入、File System Access 权限弹窗、导出保存对话框、
textarea 聚焦选中的手感。
（usePlayer 的段内播放规则已有 jsdom 假 audio 元素级测试；全链路行为仍依赖真实浏览器与音频输出。
上述真实浏览器验证仅覆盖第 5 轮验收项，不改变本节其余条目的性质——它们仍未自动化。）

## 3. 真实样本验证步骤（books/transcripts/环境画卷）

以下步骤全部只读源文件；预计 10 分钟。

1. `npm run dev` 打开 http://localhost:5173 。
2. 点「① 选择 MP3 音频」→ 选
   `books/transcripts/环境画卷/青创 一   1   7月25日 上午9点10分.mp3`
   （文件名含三个连续空格；用文件选择器正常选择，不涉及 shell 转义）。
3. 点「② 选择 SRT 字幕」→ 选
   `books/transcripts/环境画卷/青创 一 1 7月25日 上午9点10分.srt`（单个空格）。
   应显示：解析出 **1,676 个字幕段**、0 错误、0 警告；「规范化后名称一致，自动配对成立」。
4. 点「③ 导入并进入校对工作台」。导入只读取音频首尾各 64KB 计算身份指纹；原始识别层为只读层（每段灰色底小字）。
5. 逐段播放（PRD V1.0.2）：点击任一行非操作区域 → 选中该段并精确定位到段首（不自动播放）；聚焦当前播放段文本框 → 只在精确打断位置暂停（V1.1.4 AC-067），不回段首；
   行内「▶ 播放」→ 从该段段首播放，再次点击「⏸ 暂停」停在当前位置（不回段首）；到段尾自动暂停并稳定在段尾，绝不串入下一段；
   同段段内恢复按自动回退且不早于段首；双击时间码等价于该行播放/暂停开关；
   `F8`/行内播放/暂停按钮 = 当前段范围感知播放/暂停；`F7`/`F9` 后退/前进 2 秒且钳制在当前段内；
   0.80× 变速不变调；`Ctrl+L` 循环当前段（唯一的段尾回段首继续模式；换段自动解除旧循环）；
   行内「确认本段」只确认被点击的段；`Ctrl+Enter` 确认当前选中段并定位下一未校对段段首（不自动播放）。
6. 保存：编辑任一段 → 顶栏「↻ 保存中…」→ 约 0.5 秒「✔ 已保存 HH:MM:SS」。
   片段与疑点写入失败时会显示「✖ 保存失败（N 项未落盘）」并可重试，不会静默丢失。
7. 疑点：某段点行内「⚑ 疑点」→ 按钮旁展开 8 类类型选择层（无预选；Esc / 点击外部 / 再点按钮关闭且不创建），
   选择类型（如「专名」）后才为该段创建一条 blocking 疑点；`Ctrl+?` 仍直接创建「听不清 / 阻塞」疑点 →
   右栏出现未解决疑点；跳转播放 / 已解决 / 删除；顶栏与导出对话框都会显示未解决数量。
8. 恢复：刷新页面或换设备访问同一服务 → 导入页「继续上次校对」→ 打开后文本、确认状态、疑点、播放位置、速度（含真实 playbackRate）全部从服务端恢复；循环不跨会话恢复。
   源音频不上传，刷新或换设备后按提示重新定位同一 MP3；文件指纹不一致会被拒绝。
9. 重定位保护（可选）：点「重新定位音频文件…」选择**另一份** MP3 → 应被拒绝并提示
   「身份指纹不一致——它可能不是同一场录音」；选择原 MP3 → 恢复正常。
   旧版项目（迁移时无法补指纹）首次重连：按文件名+大小核对后会弹确认框「首次建立音频身份」，确认才写入。
10. 导出：点「导出 SRT…」→ 若存在空文本段会被阻塞（空段无法通过回读校验）→
    导出为新文件（默认 `<规范化名>.校对.V001.srt`）→ 自动「重新解析回读校验」显示 ✔。
    若在保存对话框中选择源 SRT 本身（Chrome），会被 `isSameEntry` 保护阻止。
11. 删除历史记录（可选，PRD V1.1.3）：回到导入页，任一最近项目条目点行内「删除」→
    出现行内确认文案「将删除该项目的字幕、校对文本、疑点和播放进度，无法撤销；不会删除本机 MP3/SRT 源文件」；
    点「取消」不应有任何变化；再次点「删除」并「确认删除」→ 条目立即消失、项目总数递减，
    换另一台设备访问同一服务也不再出现该条目；删到 0 条显示「暂无最近项目。」。
    删除失败时条目保留并显示错误：409 版本冲突会安全刷新版本信息（不会自动删除），
    需重新点击「删除」并再次确认；服务停止等其他失败恢复后可直接重试。
12. 源文件安全验证：任意时刻执行
    `sha256sum "books/transcripts/环境画卷/青创 一   1   7月25日 上午9点10分.mp3" "books/transcripts/环境画卷/青创 一 1 7月25日 上午9点10分.srt"`
    应始终得到（开发期间实测，导入/编辑/导出前后不变）：

    ```
    6c78156df9f9da405013cd5758e87f18c670243c01c6c7dd78f9885cde294173  青创 一   1   7月25日 上午9点10分.mp3
    66fde95050bc2548be0790a7eea43b362f120577fa9d45ecd092f31cd0ce81c4  青创 一 1 7月25日 上午9点10分.srt
    ```

## 4. 架构与数据安全设计

```
tingproof/
├─ src/core/      纯逻辑（可独立测试）
│  ├─ srt.ts          严格、可解释的 SRT 解析/序列化（分/秒 0..59 校验、毫秒位数规则、行号级错误）
│  ├─ time.ts         整数毫秒时间；SRT(逗号) 与显示(点号) 两种格式
│  ├─ identity.ts     配对名规范化 + SHA-256 + 音频身份指纹（size + 首/尾 64KB）
│  ├─ selection.ts    选中/确认策略纯函数（computePlaybackSegmentId / planConfirm）
│  ├─ exportSrt.ts    导出构建 + 导出后重新解析回读校验
│  ├─ exportGuard.ts  导出目标保护（isSameEntry 三态：match / clear / unverifiable）
│  ├─ fileWrite.ts    pick → 写（失败 abort，不产生半份文件）→ 回读；下载降级
│  └─ audioSource.ts  音频重定位（句柄/会话文件 + 指纹验证）
├─ src/store/     客户端仓库、服务端 API 适配与旧 IndexedDB 迁移适配层（生产事实源为服务端 API）
│  ├─ remoteRepo.ts   生产/dev 服务端 API 仓库（revision/409/不可达保护；请求携带审计来源头；预筛五方法）
│  ├─ clientIdentity.ts  持久非实名客户端实例 ID（localStorage；审计 clientId 来源，非真人身份）
│  ├─ repo.ts         仓库门面（按环境选择 remote；测试/迁移显式使用 IndexedDB）
│  ├─ idbRepo.ts      旧 IndexedDB 适配器（仅测试与迁移来源）
│  ├─ db.ts           旧适配器连接管理（4 个 object store）
│  ├─ saveCoordinator.ts  保存协调器（去重、防抖、失败保留队列可重试、状态可订阅）
│  └─ types.ts        三层文稿数据模型 + 富审计事件类型（V0.1 实现前两层）
├─ server/        服务端（node:sqlite 单文件 + WAL）
│  ├─ sqliteStore.ts  项目/片段/疑点/审计/预筛持久化；schema version（PRAGMA user_version）驱动的
│  │                  原地幂等迁移（v3：issues 机器来源列 + prefilter 三表 + 批次 claim 列）；
│  │                  集中式 appendAudit 富审计写入（与数据/revision 同事务）；原子确认
│  ├─ apiHandler.ts   /api 路由：CRUD + revision/409 + 客户端来源校验 + 只读审计查询
│  │                  + 原子确认 + 预筛五端点（config/runs/next/retry/cancel）
│  ├─ prefilterModel.ts  OpenAI-compatible 模型适配器（环境变量密钥、超时/限流退避重试、
│  │                     错误脱敏）+ 候选严格白名单校验 + 稳定 candidateKey
│  └─ main.ts         独立生产服务（静态 dist + /api，0.0.0.0）
├─ src/audio/usePlayer.ts   播放引擎（rAF 时钟、变速不变调、自动回退、A-B/整段循环）
└─ src/ui/        导入页 / 工作台 / 片段列表 / 时间轴 / 疑点面板 / 预筛面板 / 导出对话框 / 改键面板
```

### 服务端 API 与 ground-truth 审计（PRD V1.1.2 §4.4.6，已实现）

- **写入接口**：
  - 首次创建：`POST /api/projects`、`POST /api/projects/:id/migrate`（服务端缺失时）不携带
    `expectedRevision`，创建成功 revision=1；
  - 对既有项目产生实际状态变化的写操作：`PATCH /api/projects/:id/playback|media`、
    `POST /api/projects/:id/touch`、`PATCH /api/segments/:segmentId`（及规范别名）、
    `PUT|DELETE /api/projects/:id/issues/:issueId`（及兼容别名）、`DELETE /api/projects/:id`
    ——均携带 `expectedRevision`/`If-Match`，成功后在事务内 revision+1 并追加富审计事件；
  - 已定义的幂等/no-op 例外不增长 revision、不产生审计事件：幂等重复创建/迁移（同 ID 同原文）
    返回既有项目与当前 revision；语义 no-op（segment/issue 补丁与当前持久值完全相同、media 重复
    相同值）；对不存在对象的幂等删除（如删除已不存在的疑点，`deleted:false`）。
- **只读审计查询**：`GET /api/projects/:projectId/audit-events?afterId=<id>&limit=<1-500>`——
  按 id 升序稳定分页，响应含 `events` 与 `pagination.{afterId,nextAfterId,limit,hasMore}`；
  项目不存在 404；非 GET 一律拒绝；**不存在任何修改/删除审计事件的 API**（日志只追加）。
  查询遇**非 SQL NULL 且无法解析或类型不符**的 JSON 字段时明确失败（500，含事件 id 与字段），
  不把损坏静默伪装成“历史未记录”；SQL NULL 旧行仍诚实返回 null。
- **富审计事件**：每条含递增 `id`、`projectId`、写入后 `revision`、`action`、`objectType/objectId`、
  `timestamp`、`clientId`、`source`、`before`、`after`、`changedFields`、`metadata`；
  `before/after` 为结构化 JSON 对象或 null。动作词表：
  - 字幕段（按实际前后差异分类，`changedFields` 准确，`originalText` 永不可改）：
    `edit_segment_text` / `confirm_segment` / `unconfirm_segment` / `update_segment_timing` / `update_segment`；
  - 疑点：`create_issue` / `update_issue` / `resolve_issue` / `reopen_issue` / `delete_issue`
    （删除前完整记录保存在 `before`、`after` 为 null，删除后主表记录消失但事件仍可查询）；
  - 项目：`create_project`（含 `metadata.origin=create|migrate`）/ `update_playback`（轻量，摘要进
    metadata）/ `update_media`（前后快照 + changedFields）/ `touch_project` / `delete_project`。
- **语义 no-op（V1.1.2）**：与当前持久值完全相同的 segment/issue 写入、以及分阶段补丁相互抵消后
  净状态无变化的 media 更新（`durationMs` 阶段被 `relink` 覆盖回原值等）是成功但无变化的请求——
  不写对象、不增长 revision、不产生审计事件，返回当前对象与当前 revision；不存在
  `changedFields` 为空或含重复字段的空事件——media 的 changedFields 在全部补丁应用并 canonical 后
  一次性基于最终前后值计算（白名单键序、绝不重复）。失败路径（409/400/失败写入）同样零事件、
  零 revision。
- **疑点精确语义（V1.1.2）**：写返回值与审计 `after` 取自数据库最终行（canonical——请求省略
  `resolvedAt` 时持久行、返回值、审计 after 三处一致为 null）；已有疑点 `createdAt` 创建后不可变
  （篡改请求 400 回滚，无事件/无 revision 变化）；`issues.issue_id` 为全局主键——跨项目同名疑点
  写入返回 404 且双方数据/revision/审计零污染，导入/迁移新项目时 issueId 与既有项目碰撞或同一载荷内
  重复 issueId 都使整个创建事务回滚（400，不 last-write-wins）；`create_project` 快照的
  `segmentCount/issueCount` 取实际插入值，与主表 canonical 一致。
- **客户端来源（诚实边界）**：前端每个请求携带 `X-TingProof-Client-Id`（localStorage 持久的
  非实名客户端实例 ID，形如 `ci-<uuid>`）与 `X-TingProof-Source: web`；服务端严格校验长度/字符
  （非法 400），缺失时诚实回退 `unknown`/`api`。**clientId 可区分客户端实例，但不代表经过认证的人**
  ——当前无账号体系，不伪造真人身份；账号体系后置时再升级署名语义。
- **迁移与 schema 版本**：旧 SQLite 库（audit_events 仅旧 7 列：id、project_id、revision、action、
  object_type、object_id、at；富表 13 列 = 旧 7 列 + 新增 6 列）在打开时原地、幂等、无损迁移
  （`ALTER TABLE ADD COLUMN` 补齐富审计列，不 drop/recreate 表、不丢旧行；旧行新列为 null 并原样
  返回）；schema 版本记录在 `PRAGMA user_version`（当前 3），重复启动幂等，有真实旧 schema 数据库
  探针测试锁定；`audit_events` 建 `(project_id, id)` 索引支撑升序分页。**版本只进不退**：打开数据库
  先读 `user_version`，高于当前程序支持版本（3）时拒绝打开——版本号、表结构和数据保持不变（不降级、
  不执行当前 schema DDL），报错提示升级程序；只有低版本才执行迁移。**构造失败释放句柄**：数据库成功
  打开之后的任何初始化异常（读取版本、PRAGMA/SCHEMA/迁移、语句预编译——如不兼容 schema 的旧库）
  都 best-effort 关闭句柄后原样重抛，不泄漏文件描述符。

数据安全要点：

1. **源文件零写入**：应用内没有任何写回、移动、重命名源文件的代码路径；播放使用 blob URL 只读流式加载（3.5 小时 / 98 MB 的 MP3 不整段载入内存）。
2. **服务端不存音频正文（含历史数据迁移）**：服务端保存项目元数据、原始 SRT、校对层、状态、疑点、播放位置和 revision；音频默认由各设备本地选择/重定位，只上传必要的文件指纹和元数据。客户端 IndexedDB 只作为缓存或旧数据迁移来源，不能决定项目是否存在。第 1 轮样机曾把 File 存入浏览器降级路径；**v1→v2 启动迁移**在旧客户端读写之前执行：扫描旧记录，若 `media.audioFile` 为 Blob/File，只读首尾 64KB 补齐 `audioFingerprint`（不可读则置空并走旧项目重连流程），随后写回移除 `audioFile` 的纯元数据对象。迁移幂等，且有回归测试扫描验证「迁移后客户端数据库不含任何音频正文」；所有写回路径另有 `sanitizeMedia` 防御性剥离。
   **关于物理回收（如实说明，不做即时回收承诺）**：迁移只是逻辑写回；浏览器对已解除引用的大 Blob 的磁盘回收时机由浏览器决定，Chrome 可能延迟到浏览器关闭/重启后才释放。主审计方实测：旧 profile 升级后 IndexedDB 磁盘占用由约 96MB 降至 2.3MB，重启同一 profile 后 `navigator.storage.estimate().usage = 2,287,929` bytes，DB v2 中保留 1,676 个字幕段与原始 SRT，且不存在 `media.audioFile` 或任何 Blob 正文。不承诺所有浏览器都会即时或以相同幅度回收。
3. **音频身份指纹**：`SHA-256("afp1|size|head64KB哈希|tail64KB哈希")`，导入时计算，参与项目 ID；重定位时重新计算并按 `decideRelocate` 三态决策：指纹一致 → 直接重连；不一致 → 拒绝；旧项目无可用指纹 → 按记录中的规范化文件名与大小核对，一致时必须**用户显式确认**「首次建立音频身份」后才写入新指纹（绝不无提示接受，也不让旧项目永久锁死）。
4. **原始识别层写一次 + 幂等导入**：`srt_source` 只在首次导入写入；重复导入（同 ID + 同原文）直接返回既有项目，**不重置**校对文本、状态、版本号与疑点（有测试锁定）；同 ID 不同原文 → `SourceImmutableError`。
5. **校对层白名单更新**：`updateSegment` 只接受白名单字段，`originalText`、时间轴、cueNo 即使传入也被忽略；`upsertSegment` 已从仓库层移除（不存在整条覆盖路径）。
6. **保存协调器**：片段、疑点、播放设置的持久化统一经过 `SaveCoordinator`——500ms 防抖、按目标去重、顺序执行；**执行中同 label 新写入不会被执行完成的旧操作误删**（身份比较）；**并发 flush 语义为 join**：导航护栏在自动保存进行中调用 flush 会等待同一队列（含执行中入队的新 op）真正完成并观察最终 saved/failed 状态，不会拿 saving 状态误放行（deferred 回归测试锁定）；失败时状态栏显示「保存失败（N 项未落盘）」并保留可重试队列。「返回项目页」与「重新定位音频」都先 `safeNavigate`（await flush，失败留在工作台并明确提示）。播放位置每 5 秒与**暂停时立即**持久化（准确位置写入）；周期计时器只创建一次，UI render 不重置计时（harness 测试锁定）。
7. **播放偏好真实恢复**：挂载与元数据就绪时通过 `applyPlaybackPreferences` 把保存的速度写入 `playbackRate` 并开启变速不变调（此前只进 React state，实际仍 1.0×——已修复并有桩测试）。A-B/整段循环是会话内临时状态，不跨会话恢复，`loopSegmentId` 恒写 null，不做虚假记录。
8. **导出保护与诚实表达**：
   - 空文本段是阻塞项（空段回读必然失败，有测试证明根因），导出前直接阻止；
   - 有源句柄时用 `isSameEntry` 阻止把导出写到源 SRT / 源 MP3（三态：match 阻止 / clear 放行 / unverifiable 默认阻止）；
   - 无源句柄时界面明确写「无法自动校验，请在保存对话框中不要选择源文件」，不做无法保证的承诺；
   - FS Access 写入失败时调用 `abort()` 丢弃临时内容，不产生“半份文件替换”的含混结果。
9. **逐段播放与选中/确认策略**（可解释、有测试，PRD V1.0.2）：普通播放只允许当前选中段 `[start_ms, end_ms)`——到 end_ms 自动暂停并把位置稳定在段尾（rAF 主检测 + timeupdate 兜底，段尾分支不再排帧）；循环 region 是唯一「段尾回段首继续」模式且仅当 region 与当前段一致时生效，换段时旧循环自动解除；行内按钮是播放/暂停开关（播放中点击停在当前位置，不回段首；同段段内恢复自动回退不早于段首；换段/段尾/段外从段首开始）；点击行 = 选中 + 精确定位 startMs + 暂停旧段（不自动播放）；聚焦当前播放段文本框 = 只在精确打断位置暂停并记续播点（AC-067）；`Ctrl+Enter` 确认后定位下一未校对段段首（不自动播放）；已确认段再次点击同一按钮为「↶ 取消确认」——
有未解决疑点回到「有疑点」、否则回到「校对中」，经保存队列持久化（刷新保持）；
行内确认/取消确认都会把选中段与活动播放范围切换为「按钮所在行」（不自动播放、不改变播放头、绝不选择下一段）；只有 `Ctrl+Enter` 才前进到下一未校对段。
行内「⚑ 疑点」为轻量类型选择层（8 类、无预选、单例，Esc/外部/再点按钮仅关闭），选定类型才创建一条 blocking 疑点；
菜单经 portal + fixed 定位并碰撞感知（默认向下，底部空间不足向上，钳制进列表可视区，不改变列表 scrollHeight/scrollTop；滚动列表/改窗口尺寸时关闭）；
按钮与菜单不冒泡成行定位、不改变播放头。F7/F9 与播放中 seek 钳制在当前段内。人工滚动接管最高优先级：wheel/触控板/原生滚动条按下/拖动/
滚动键（Arrow/PageUp/PageDown/Home/End，非文本焦点）的第一个事件立即暂停跟随并清除程序滚动标记；
程序 scrollIntoView 采用「消费一次」标记（不吞其后真实输入）；拖动滚动条全程禁止程序滚动，pointerup/pointercancel 同步清理，
滑块从按下起持续跟鼠标。列表已移除 content-visibility 估算高度（消除滚动条 thumb 漂移，正确性优先）。播放→选中的订阅只依赖稳定引用，纯 render 不会重订阅并用旧播放位置覆盖显式选中（jsdom harness 回归）。
10. **受控元数据更新**：音频时长经 `updateMediaDuration` 单独字段写回，刷新后仍可读回（有测试）；持久化路径不依赖渲染期 meta 快照（审计 P1-7：已移除 onDuration 对 metaRef 的本地改写，所有写库字段显式传入）。

## 5. 审计修复记录

### 第 9 轮（V1.1.4 真实标注反馈与文本预筛，AC-067 至 AC-071）

| # | 需求/审计项 | 实现 | 验证证据 |
| --- | --- | --- | --- |
| AC-067 | 真实审计记录：播放中的当前段在文本框聚焦后被写回段首（重复回听） | usePlayer 新增 pauseForEdit + 一次性编辑打断续播点：同段续播从精确打断点且本次回退 0ms；标记在 play() 成功后消费（reject 保留重试）、seek/±2s/循环/换段/段尾/ended/时间轴变化清除；SegmentList 拆分 onLocate（行空白区=精确定位段首）与 onEditorFocus（当前播放段=只暂停）两语义 | `tests/editInterruptResume.test.tsx`（13 例）：精确暂停 ±100ms、无回退续播、一次性消费后回常规回退、各清除路径、play reject 保留与重试、ended 清理、Workbench 聚焦当前段/另一段/行空白区语义分离 |
| AC-068 | 真实审计记录：两次段落确认后分别紧跟人工 resolve_issue（重复点已解决） | 服务端 `POST /segments/:id/confirm`：一次事务确认段（含 correctedText 草稿）+ 按稳定 issueId 顺序解决本段全部 open 疑点（同一确认时间）；revision 只 +1；confirm_segment + resolve_issue 共享 revision/时间戳，metadata.cause=segment_confirm；no-op/409/注入子写失败（SQL trigger）整体回滚；idbRepo 镜像实现；Workbench 经 SaveCoordinator 同标签入队（替换 pending 文本保存避免 409）+ flush 立即执行 | `tests/confirmAtomic.test.ts`（7 例）、`tests/confirmIdb.test.ts`（3 例）、`tests/workbenchConfirm.test.tsx`（8 例，含自动解决后未解决计数消失/撤销不重开/持久层复核）、`tests/confirmFailure.test.tsx`（1 例失败路径） |
| AC-069 | 文本预筛输入与候选校验 | 模型只收冻结的 segmentId/cueNo/originalText；validatePrefilterResponse 严格白名单（顶层仅 items、六字段、枚举/长度、原文逐字子串、单段≤3、批内 candidateKey 去重、未知字段/顶层拒绝）；合法候选 → warning 级 machine_prefilter 疑点（machine_metadata 含 reason），正文/段状态不变；冻结后已确认段候选记 rejected 不产生 open 疑点 | `tests/prefilterServer.test.ts`：输入键集合断言、合法候选落库、7 类非法全部拒绝计数 + rejected 行持久化、整批失败可重试、确认后冻结候选拒绝 |
| AC-070 | 批次幂等与恢复 | 批次短事务原子 claim（queued/failed→running，CAS；并发第二请求不调模型不跳批）；close() 释放本实例认领 + 10 分钟租约兜底回收崩溃残留；inputHash 幂等（同项目成功批次直接复制不调模型）；run 级 scope 复用；已删除/已解决候选按 candidateKey 项目级去重不复活不重开；取消保留成功批次——含取消竞态：模型 in-flight 时取消，当前批完成后 recompute 保留 run=cancelled（计数照常更新），不伪装完成 | 同上文件：3 批 run 重启续跑（批 1 不重调）、Promise.all 并发模型只调 1 次、store close/reopen 与租约回收、21 段 inputHash 复制、删除不复活/解决不重开、取消保留 processed、取消竞态（deferred 模型：取消后当前批 succeeded、后续 cancelled、run cancelled、模型只调一次） |
| AC-071 | 来源、安全与降级 | config 只回 available/provider/model/promptVersion；API key 只在服务端环境变量、不入库/回传/日志/审计；机器 create_issue 审计 source=machine_prefilter、metadata 含 provider/model/promptVersion/sourceTextHash/runId/batchId/candidateKey/confidence、不含提示词/密钥/整批正文；未配置 503+环境变量名提示；预筛推进 revision 后旧 revision 手动写 409 | 同上文件：config 脱敏断言、审计来源完整性与敏感信息排除、503、revision 409；`tests/prefilterUi.test.tsx`：未配置降级（无 run 请求）、运行循环/重试/取消、机器建议 ×N 与疑点卡展示 |
| 迁移 | schema v2→v3：issues 增 origin/machine_metadata（旧行 human/null）+ 预筛三表；真实库曾处于中间态（user_version=3 但缺 claim 列） | migrateSchema 按列存在性幂等补齐（不依赖版本号跳过）；SCHEMA_VERSION=3 只进不退；deleteProject 级联清理预筛数据 | 同上文件：构造 v3 旧 14 列库 → 补 claim 列、数据不变、claim 可用、重复构造幂等 |
| 复审 P0-1 | 疑点刷新并发协调存在真实缺陷：合并决策写在 React setState 更新器内（延迟执行）而 journal 清理在 finally 同步先行——旧快照在保护失效后覆盖本地结果；confirm-resolved 被无条件永久保护（新 GET 无法接受跨设备更新/删除）；已 ack mutation 对"ack 前发起、可能漏读该写入"的在途 GET 无保护；pending 集合无 per-mutation token（旧保存成功会错误 ack 更新 mutation）；服务端缺失的本地疑点被无条件保留（跨设备删除永不同步）；**第 10 轮追加**：noteConfirmed 无条件覆盖 journal + 删除 pending token——确认请求在途期间更晚的本地 delete/resolve 会被 confirm 响应打穿，删除保存未成功/失败期间服务端旧行复活本地删除 | 重做为独立协调器 `src/store/issueSync.ts`：单调时钟全序 + per-ID journal（local/confirmed + ackedClock）+ per-mutation pending token；保存 op 开始时捕获 token，成功仅当 token 仍是最新才 ack（在途旧保存不能清新 mutation，失败保持 pending）；confirm 原子结果不进 pending、只保护 confirm 前发起的旧读（非永久）；**第 10 轮**：confirm 响应到达时若该 ID 有更晚的本地 pending mutation，保留其 local 条目与 token（不覆盖/不 ack/不删除），由该保存最终落盘收敛，仅最新 save token 成功才 ack；已 ack 条目按 `ackedClock > read.clock` 精确保护可能漏读的在途读；合并决策在响应到达时同步冻结（freezeDecisions，绝不放进延迟执行的更新器）；仅最新 GET 应用、旧 GET 丢弃；未 touched 完全以服务端为准（含缺失即跨设备删除）；journal 按读取边界清理无泄漏 | `tests/issueSync.test.ts`（11 例协调器确定性单测：旧 ack/新 pending/confirm 不覆盖 pending（第 10 轮）/confirm 在途本地删除合并层/ack 前后读取边界/journal 清理/读取代次/合并纯函数）；`tests/issuesRefreshRace.test.tsx`（9 例真实 deferred 竞态：双 GET 并发反序断言调用=2、pending 中 resolve 与 create 各自等 upsertIssue 真正成功（deferred 完成信号）后释放不回滚并精确断言完整参数、mutation 先于 GET 且保存 pending 不覆盖、同 issue 旧保存在途→新 mutation→旧 ack 不清新 pending 最终保存最新、confirm 保护旧读且新 GET 可删除、confirm 在途本地删除→deleteIssue 挂起→失败→重试成功全程不复活（已用旧缺陷注入验证该例确实失败）、删除不复活、跨设备删除同步；精确断言 upsertIssue/deleteIssue/confirmSegment 参数） |
| 复审 P1-4/P1-5 | 预筛 latest 错误恢复与取消竞态收尾：latest 失败后同面板显式 start 成功需清旧错误；cancel 后迟到已落库批次只刷新 issues 不刷新 latest 计数；旧 GET/旧 operation 迟到不得清新错误；**第 10 轮追加**：cancel 请求响应挂起期间迟到 next processed=true 先返回——cancel 状态未记录导致同步被跳过，随后 cancel 响应携带 materialize 前旧快照，UI 永久停在旧计数 | runLoop 成功取得权威 run 时清 latestRunError（仅当前操作）；旧操作迟到落库（processed=true）→ issues 只读刷新一次 + cancel 点击即记录状态（含响应未返回的在途取消）：cancel 响应已落地且仍是最新操作且 UI 仍指向该 cancelled run 时只读 latest 一次应用最终 processed/created/reused/rejected（status 显式钉死 cancelled）；**第 10 轮**：迟到批次先于 cancel 响应到达 → 标记 syncRequested，cancel 响应落地后补做恰好一次只读 latest（两种响应顺序合计恰好一次，不重复）；期间有新操作/新 run 绝不覆盖；取消失败清除在途状态；该同步不清除 latestRunError（错误由显式重试或新的当前操作清除） | `tests/prefilterDeferred.test.tsx` 5 例：latest 首败→状态读取失败→同面板 start 成功→完成态且旧错误块消失；旧 GET 迟到 resolve 与旧 operation 迟到落库均不清新错误（取消 run 计数照常同步、latest 恰好 +1）；cancel 后迟到批次 issues +1/latest +1/最终计数 4/4 且不轮询不 create 不额外 next；**cancel 响应反序**（cancel 挂起→迟到 next 先返回 issues +1 且 latest 零调用→cancel stale 0/4 快照返回→恰好补一次 latest 恢复 4/4 且保持 cancelled）；取消后新 run 完成不被旧迟到批次覆盖（latest 零调用）；`tests/confirmDeferredRace.test.tsx` 3 例：行内 advance:false 与 **Ctrl+Enter advance:true** 双路径 confirm 在途 T1→T2——精确断言 updateSegment(T2,"editing")、文本 T2、目标段未 confirmed、行内路径选中不被切换 / Ctrl+Enter 路径不选中/定位/聚焦下一段、confirm 参数为 T1；A pending+B-old 被替换精确保存 T2 且 confirmSegment=0 |

### 第 8 轮（删除历史记录，PRD V1.1.3 / AC-066）

| # | 需求/审计项 | 实现 | 验证证据 |
| --- | --- | --- | --- |
| 1 | 用户需求「除了打开按钮之外，增加删除按钮，删除历史记录」 | ImportScreen 最近项目每条「打开」旁新增「删除」按钮（`button.danger` 现有 danger 样式，白底不变；可访问名称「删除 <项目名>」）；点击展开行内二次确认，文案明确“将删除该项目的字幕、校对文本、疑点和播放进度，无法撤销；不会删除本机 MP3/SRT 源文件”；取消零请求、列表不变 | `tests/importDeleteProject.test.tsx`：双按钮渲染与可访问名称、取消零调用、文案断言 |
| 2 | 删除必须落在服务端项目空间，跨设备消失 | 确认后调用既有仓库 `deleteProject`（remote 路径复用 `DELETE /api/projects/:id` + `expectedRevision`，不扩大后端协议）；服务端同一事务删除项目行、SRT、segments、issues、播放进度 | `tests/remoteRepo.test.ts` 删除集成：listProjects 提供 revision 后 DELETE 成功；项目与业务行经 API 404；直接扫描临时 SQLite 确认 projects/segments/issues/srt_source 行消失 |
| 3 | 防误删与失败语义 | 删除期间仅目标条目按钮禁用（删除按钮显示“删除中…”），不打开该项目、不阻塞其他项目；重复点击最多一次调用；成功后本地列表立即移除（无整页刷新）、总数递减、删到 0 条显示“暂无最近项目。”、分页计数不出现负数或幽灵条目；**409 版本冲突：只安全刷新列表与 revision（绝不自动重试删除），目标行保留并提示用户重新点击「删除」并再次确认，第二次确认以最新 revision 删除成功；安全刷新失败保留当前列表与目标行并提示稍后重试**；服务不可达等其他失败保留条目、恢复按钮、显示清晰错误可重试。另：任何更早发出的迟到列表响应不得复活已删除条目（请求代次 + 删除失效保护，非永久 tombstone），多项目并发删除安全 | `tests/importDeleteProject.test.tsx`：防重复（双击一次调用）、只删目标项其他项保留、最后一项删除后空状态、失败保留并可重试、409 冲突（不自动重删+安全刷新+再次确认成功）、409 且刷新失败列表不清空、迟到旧列表响应无幽灵条目（受控 deferred + 并发删除）、>20 条分页边界 |
| — | 主审计复验：409“可重试”曾为假语义（revisionCache 不更新则必然再次 409）；列表整表刷新存在迟到旧响应复活已删条目的竞态 | 409 收到 RevisionConflictError 后只做安全刷新（refreshProjectsSafely，失败保留列表），提示后由用户再次确认；列表刷新统一走请求代次（listGen，旧代次响应丢弃）+ 删除失效保护（pendingDeleted：删除后发出的刷新返回才解除，同 projectId 重建不受影响） | 同上行证据；`tests/remoteRepo.test.ts` 409 对抗：B 持旧 rev DELETE → RevisionConflictError 且服务端零副作用（业务行保留、revision 未推进、无 delete_project），刷新后显式再删成功且仅一条 delete_project |
| 4 | 源文件零触碰 + 审计保留 | 应用内不存在任何删除源文件的代码路径；`delete_project` 审计行（含删除前项目摘要）按 V1.1.2 契约长期保留，不新增审计删除接口 | `tests/remoteRepo.test.ts`：临时 SQLite 扫描确认 delete_project 审计行仍在（before 快照完整），服务端 API 无任何审计删除路由（既有 AC-062 测试锁定） |

### 第 7 轮（主审计复验修正，PRD V1.1.2）

| # | 审计项 | 修法 | 验证证据 |
| --- | --- | --- | --- |
| P0-1 | 跨项目 issueId 污染：`issues.issue_id` 全局主键，putIssue 对已存在但属于另一项目的同名疑点不校验，会改写他项目疑点并泄漏含其 before 的审计 | putIssue 事务内先读旧行校验项目归属，跨项目冲突 404（双方数据、revision、审计零污染）；insertProjectTx 导入 issues 前检查全局碰撞，冲突则整个新项目创建事务回滚 | `tests/auditEvents.test.ts` 跨项目对抗 2 例：p1 名义写 p2 疑点 → 404、p2 疑点/revision/审计原样、p1 零污染；导入携带碰撞 issueId → 400 且项目未创建、既有疑点未被改写 |
| P0-2 | schema 版本倒退：migrateAuditEvents 无条件 `PRAGMA user_version=2`，未来版本（99）库会被降到 2 | 构造器先读 `user_version`：高于 `SCHEMA_VERSION` 时关闭句柄并抛错（不降级、不执行任何 DDL，版本/表/数据原样）；低版本才执行 SCHEMA 与迁移 | `tests/auditMigration.test.ts` 未来版本 1 例：99 → 构造抛错、版本仍 99、表仍旧 7 列、行数不变、句柄零泄漏（/proc/self/fd 计数）、降回 0 后可正常迁移 |
| P0-3 | 疑点 after 非数据库最终值：请求省略 resolvedAt 时 SQL 存 NULL，但返回值与审计 after 直接用请求对象（字段缺失） | putIssue 写入后从数据库行构造 canonical IssueRecord，作为返回值与审计 after | `tests/auditEvents.test.ts` canonical 1 例：省略 resolvedAt → 返回值、审计 after、listIssues 三处 `"resolvedAt" in obj` 且为 null |
| P0-4 | createdAt 可被静默篡改且 changedFields=[]：更新已有疑点 createdAt 10→999 会写库并产生空事件 | 已有疑点请求 createdAt 与原值不同 → 400 回滚（无写入、无事件、无 revision 变化），文档化“创建时间不可变”语义 | `tests/auditEvents.test.ts` createdAt 1 例：篡改 → 400、事件数不变、revision 不变、持久行 createdAt=10 且 note 未写入 |
| P1-5 | 语义 no-op 污染审计：完全相同的 segment 补丁与 issue upsert 各自产生空事件并 bump revision | updateSegment/putIssue 基于 canonical 前后值判断：changedFields 为空 → 不写对象、不 bump revision、不产生审计，返回当前对象与当前 revision；原先把空事件视为正确的测试改为断言新语义 | `tests/auditEvents.test.ts` no-op 2 例（segment/issue）：重复提交 → 200、revision 不变、对象 revisionNo 不变、事件数不变；AC-063/§4.4.6/README 同步写明 |
| P1-6 | 非 NULL 损坏审计 JSON 被 catch 后静默变 null，把损坏伪装成历史未记录 | rowToAuditEvent 严格解析：SQL NULL → null；非 NULL 且 JSON 无法解析或类型不符（对象字段收到数组/标量、数组字段收到非字符串数组）→ 抛错并带事件 id 与字段名 | `tests/auditMigration.test.ts` 损坏 JSON 1 例：三种损坏（非法 JSON/数组当 changedFields/数组当 after）均明确抛错；SQL NULL 旧行仍返回 null |
| P2-7 | `git diff --check` 失败（待确认清单第 3 行 trailing whitespace） | 清除行尾空白，`git diff --check` 通过 | 本轮 `git diff --check` 输出为空（exit 0） |
| P1-8 | 创建/迁移载荷内重复 issueId 静默 last-write-wins：主表只剩后一条，但 create_project.after.issueCount=2（快照与主表分裂） | insertProjectTx（create/migrate 共用路径）对同一载荷内重复 issueId 显式拒绝（400），整个创建/迁移事务回滚，不生成项目或审计；快照计数改取实际插入值 | `tests/auditEvents.test.ts` 2 例：重复 issueId → 400、项目 404、issues/segments/srt_source/audit_events 零遗留行（直接扫描临时库）；成功创建含 2 条疑点 → after.issueCount=2 且与主表一致 |
| P1-9 | updateMedia 分阶段累加 changedFields：`{durationMs:100, relink:{durationMs:null}}` 净 no-op 却 revision+1 并产生 changedFields=["durationMs","durationMs"]、before===after 的空事件 | 保持字段应用优先级与最终语义不变；全部补丁应用并 canonical 后一次性基于最终 before/after 计算 changedFields（MEDIA_KEYS 键序，绝不重复）；净状态无变化 → 不写、不 bump、不产生审计，返回当前对象与当前 revision | `tests/auditEvents.test.ts` 1 例（两段合一）：先改后抵消 → revision 不变、持久值不变、零事件；同字段两阶段最终变化（100→relink 200）→ changedFields=["durationMs"] 只出现一次、after 与持久值一致 |
| P1-10 | “构造失败关闭 DB 句柄”只覆盖 future-version 分支：不兼容 schema 的库（残缺 projects 表）在语句预编译时抛错，句柄泄漏（/proc/self/fd 0→1） | 构造器把 open 之后的全部初始化（读版本、PRAGMA/SCHEMA/迁移、prepare statements）包进统一 try/catch：任何异常 best-effort close 后原样重抛；future-version 分支改为只 throw，由统一 catch 关闭（无 double-close），成功构造不变 | `tests/auditMigration.test.ts` 1 例：不兼容 schema（仅残缺 projects 表 + 既有行）→ 构造抛 “no such column”、FD 计数不增加、既有表/数据不被删除；既有 future-version 测试保留不变 |
| 口径 | 旧版 audit_events 实为 7 列（id、project_id、revision、action、object_type、object_id、at），此前文档/注释误写“6 列” | README/PRD/测试注释统一改为“旧 7 列”（富表 13 列 = 旧 7 + 新增 6，`AUDIT_EVENT_V1_1_1_COLUMNS` 的“新增 6 列”本就正确未动）；无运行逻辑改动 | `rg "6 列"` 复核：仅错误口径“旧 6 列/仅 6 列”无残留；正确的“新增 6 列”表述（指富审计新增列数）按要求保留 |

### 第 6 轮（ground-truth 富审计，PRD V1.1.1）

| # | 审计项 | 修法 | 验证证据 |
| --- | --- | --- | --- |
| 1 | `audit_events` 只有 action/object/time，无法还原人工标注过程（马上要人工标注一个文件并形成机器预筛评估的 ground truth） | 升级为追加式富审计日志：集中式 `appendAudit` 与数据写入/revision 增长同事务；新增 `client_id/source/before_json/after_json/changed_fields_json/metadata_json` 列 + `(project_id, id)` 分页索引；疑点动作分类（create/update/resolve/reopen/delete，删除前完整 before、after=null）；字幕段按实际前后差异分类（edit_segment_text/confirm_segment/unconfirm_segment/update_segment_timing/update_segment）且 changedFields 准确 | `tests/auditEvents.test.ts`（14 例）：创建/编辑/确认/撤销/疑点全生命周期的动作分类、before/after 完整 SegmentRecord/IssueRecord、originalText 不可改、删除后主表消失但 delete_issue 的 before 仍完整可查询 |
| 2 | 无账号体系却需要区分事件来源 | 前端 `clientIdentity.ts` 持久非实名 client instance ID（localStorage，`ci-<uuid>`）+ `X-TingProof-Source: web`；服务端严格校验长度/字符（非法 400），缺失诚实回退 unknown/api；文档与实现均声明 clientId 不代表经过认证的人 | `tests/auditEvents.test.ts`：合法记录、非法 400、缺失回退、remoteRepo 生产路径自动携带 |
| 3 | 审计数据无法被外部消费 | 只读 `GET /api/projects/:id/audit-events?afterId&limit`（1–500 严格校验，404，非 GET 拒绝，升序分页无重复无遗漏）；类型 `AuditEventRecord` 同步到共享 `src/store/types.ts`；remoteRepo 提供 `listAuditEvents` 导出方法 | `tests/auditEvents.test.ts`：参数校验（0/501/非整数/负数均 400）、默认 limit=100、105 事件分页遍历、重启前后遍历结果一致 |
| 4 | 旧 SQLite 库升级风险（丢旧审计事件/需要重建表） | `PRAGMA user_version` 显式 schema 版本（该轮当时为 2；当前为 3）；构造 store 时按列检查 `ALTER TABLE ADD COLUMN` 原地补齐，不 drop/recreate 表；旧行新列保持 null 并原样返回；重复启动幂等 | `tests/auditMigration.test.ts`（3 例）：真实旧 schema 数据库探针（旧 7 列 audit_events + 旧行）→ 迁移无损、旧事件可读（新列 null）、业务数据不变、新写入带完整富审计列、二次/三次启动幂等、新库直接最新 schema |
| 5 | 失败路径可能污染审计（409/校验拒绝也记事件） | 只在成功事务内追加；幂等删除不存在疑点/media 相同值重复提交不产生事件、不增长 revision | `tests/auditEvents.test.ts`：409、未知字段 400、非法疑点 400、删除幽灵疑点、media no-op 均零事件且 revision 不变 |

### 第 5 轮（真实浏览器布局验收）

| # | 审计项 | 修法 | 验证证据（本次主审计方真实浏览器执行，非 agent 环境自动化） |
| --- | --- | --- | --- |
| P1 | ≤1100px 下超长列表溢出覆盖疑点面板（900×900 实测：`.wb-list` overflow visible，1676 行直接绘制越过 y=519 的侧栏） | 窄屏块重写：`.wb-main` `overflow:hidden`；`.wb-list` `flex:1 1 0; min-height:0; overflow-y:auto` 成为独立滚动区；`.wb-side` `flex:0 1 auto; max-height:45%; min-height:160px; overflow:hidden` 固定在列表下方限高；`.issue-list` `flex:1; min-height:0; overflow-y:auto` 自身滚动 | 主审计方以真实 Chrome 153、900×900 验证：`document.body` 900/900 无横向溢出；bounding boxes 中 list.bottom = side.top、side.bottom = player.top（无重叠）；字幕列表独立滚动时 side/main/window 均不滚动；临时扩充疑点后 issue-list 可独立滚动；页面白底 `rgb(255,255,255)`；network/console problems 均为 0 |
| P2 | `GET /favicon.ico 404`（控制台唯一错误） | `index.html` 增加内联 SVG data URI 图标（蓝底“听”字，全 percent-encoded，零外部请求） | 主审计方复验：network/console problems 均为 0，404 消失，运行期仍完全离线 |

### 第 4 轮

| # | 审计项 | 修法 | 测试证据 |
| --- | --- | --- | --- |
| P0-1 | flush 进行中并发调用立即返回，safeNavigate 拿 saving 状态误放行 | flush 改为 join 语义：`activeFlush` promise，第二调用等待同一队列（含执行中入队的新 op）真正完成并观察最终 saved/failed | `tests/saveCoordinator.test.ts` 2 个 deferred 用例：op1 挂起时第二个 flush 在 release 前不 resolve；release 后 calls=[op1,op2] 队列清空 state=saved；失败场景 join 者观察到 failed 且 safeNavigate 不放行 |
| P0-2 | 订阅 effect 依赖整个 player 对象：render 重订阅→立即回调旧位置覆盖显式选中 | 抽取 `usePlaybackSelection`：依赖仅稳定的 `subscribeCurrentMs`；排序/回调经 ref 读取 | `tests/selectionSync.test.tsx`（jsdom harness，5 例）：暂停在第一段时显式选 s2 → 多次纯 render 后 subscribeCount 仍为 1 且选中保持 s2；播放进入 s2 才接管；间隙不接管；卸载退订；引用变化才重订阅 |
| P0-3 | 5 秒保存 effect 依赖整个 player：每个字幕段切换的 render 都重置 interval | 抽取 `usePeriodicPersist`：interval 只创建一次（依赖仅 intervalMs），shouldRun/run 经 ref；Workbench 传 `playerRef.current.playing` | `tests/periodicPersist.test.tsx`（fake timers harness，3 例）：4.9s 处多次 render 不重置计时、满 5s 必触发、连续播放第二周期再触发；暂停不触发；卸载停止 |
| 附带 | 其余 player 对象依赖核对 | applyConfirm/seekToSegment/toggleLoopSegment/键盘 effect 全部改走 `playerRef`，依赖收窄为稳定集合；不再有任何 effect/callback 依赖整个 player 对象 | `grep` 复核 deps 列表；tsc/eslint 通过；全部既有测试不回归 |

### 第 3 轮

| # | 审计项 | 修法 | 测试证据 |
| --- | --- | --- | --- |
| P0-1 | 旧版大音频残留 IndexedDB | `DB_VERSION 1→2`；`migrateLegacyAudioFiles` 在任何 list/get 之前执行：扫描含 `media.audioFile`（Blob/File）的记录，只读首尾 64KB 补指纹（不可读置空），写回剥离 `audioFile` 的纯元数据；幂等；repo 全部写回路径加 `sanitizeMedia` 防御 | `tests/migration.test.ts`（5 例）：真实构造 v1 库含 File → 升级后字段彻底消失、指纹=按正文计算的值、文本/状态/版本/播放/原文不变、二次迁移计数 0、raw 扫描无任何 audioFile |
| P0-2 | flush 执行中同 label 入队被误删；返回/重定位丢 500ms 窗口 | flush 只删除「仍是同一 op 对象」的队列项；「← 项目」与重定位先 `safeNavigate`（await flush，失败留在工作台并显示原因） | `tests/saveCoordinator.test.ts` deferred 用例（op1 挂起中入队 op2 → 两次都执行、队列清空）；`tests/navigation.test.ts`（4 例 + 与真实协调器集成） |
| P0-3 | 恢复速度未真正生效；暂停未持久化；loopSegmentId 虚假写入 | 挂载/元数据就绪时 `applyPlaybackPreferences` 写 `playbackRate`+变速不变调；Workbench 传 `onPauseChange`，暂停即写准确 positionMs；循环为会话临时状态，`loopSegmentId` 恒写 null 不虚报 | `tests/audioPrefs.test.ts`（0.8× 实际写入 playbackRate、preservesPitch、钳制）；README 声明同步；audio 元素全链路归人工验证 |
| P0-4 | 旧项目无指纹时重定位全被拒；无提示接受 | `decideRelocate` 纯函数三态：指纹匹配 accept / 不一致 reject / 无指纹按规范化文件名+大小核对后 `confirm-establish`（用户显式确认才写入新指纹）；迁移能补则补 | `tests/legacyReconnect.test.ts`（7 例：匹配、不匹配、名称错、大小错、全缺、空白指纹） |
| P1-5 | 编辑第二行时选中仍在第一行 | textarea `onFocus` 与行 `onPointerDown` 显式把该行设为选中段 | 实现接线；手感归浏览器验证（README §2 已列） |
| P1-6 | 页面底色仍为灰 | `--bg`/画布/时间轴/弹层全部 #ffffff，侧栏保留极浅灰层次 | styles.css；截图目检归浏览器验证 |
| P1-7 | metaRef 快照冲掉本地更新；持久化靠陈旧快照 | 移除 onDuration 对 metaRef 的改写；所有写库字段显式传入（updateSegment/updateMediaDuration/savePlayback/relinkAudio） | `tests/store.test.ts` 时长与播放位置回归；代码路径复查 |

### 第 2 轮

| # | 审计项 | 修法 | 测试证据 |
| --- | --- | --- | --- |
| 2 | File 入库（198MB） | MediaInfo 移除 `audioFile`；会话内内存传递；刷新后走重定位；重定位支持 `<input>` 降级 | 实现约束 + `tests/audioSource.test.ts`（无 File 入库路径、会话文件指纹校验） |
| 3 | 活动/确认逻辑错误 | `selection.ts` 纯函数 + 显式选中段模型；行内确认用被点击 id | `tests/selection.test.ts`（13 例：间隙、预卷、跨段点击） |
| 4 | 重定位任意 MP3 | 音频指纹（size+首尾64KB）+ mediaKey 纳入 + 重定位比对 | `tests/identity.test.ts`（同名同大小不同内容不碰撞）+ `tests/audioSource.test.ts`（不匹配拒绝） |
| 5 | 疑点 fire-and-forget | `SaveCoordinator`：失败→failed 状态+保留队列+重试 | `tests/saveCoordinator.test.ts`（6 例） |
| 6 | upsertSegment 绕过白名单；导入不幂等 | 移除 upsertSegment；createProject 幂等返回既有项目 | `tests/store.test.ts`（校对稿/版本/疑点不重置；导出缺失断言） |
| 7 | durationMs 未落库 | `updateMediaDuration` 受控更新 | `tests/store.test.ts`（重开后仍在） |
| 8 | 空文本段导出必然失败 | 定义为阻塞项，导出前阻止；不再出现“勾选后写出失败” | `tests/exportRoundTrip.test.ts`（空段回读失败根因） |
| 9 | 分/秒无 0..59 校验；毫秒位数含糊 | 分秒 0..59 严格错误；毫秒 1–2 位=告警、≥4 位=错误 | `tests/srt.test.ts`（00:99:99,999、60 分、1 位毫秒、4 位毫秒） |
| 10 | 导出可覆盖源 SRT；写失败含混 | 持久化源句柄 + isSameEntry 三态保护；写失败 abort；文案按能力分级 | `tests/exportGuard.test.ts`（match/clear/unverifiable） |
| 11 | README 错误声明 | 存储/验证表述重写（本节 §2/§4/§7） | — |

## 6. 默认快捷键（PRD 2.3.4，可改键）

| 动作 | 默认键 | 说明 |
| --- | --- | --- |
| 播放 / 暂停（当前段） | `F8` 或行内播放/暂停按钮 | 范围感知：播放中暂停在当前位置（不回段首）；同段段内恢复自动回退（不早于段首）；段尾/段外从段首 |
| 后退 2 秒 | `F7` | 钳制在当前段内 |
| 前进 2 秒 | `F9` | 钳制在当前段内 |
| 上一段 / 下一段 | `Alt` + `←` / `→` | 选中并精确定位到段首；正在播放先暂停 |
| 确认当前选中段并前进 | `Ctrl` + `Enter` | 定位下一未校对段段首，不自动播放 |
| 确认 / 取消确认（行内按钮） | — | 只作用于被点击的段，与播放位置无关；已确认段再次点击即撤销确认 |
| 选中某段 | 点行非操作区域 | 精确定位到该段 startMs；不自动播放；人工滚动列表即暂停跟随，显式定位/播放或「回到播放点」恢复 |
| 播放 / 暂停（行内开关） | 点行内 `▶ 播放` / `⏸ 暂停` | 双击时间码等价；按钮文案与可访问名称随状态切换 |
| 循环当前段 | `Ctrl` + `L` 或行内 `⭯ 循环` | 再按一次解除；唯一的段尾回段首继续模式；换段自动解除旧循环 |
| 创建疑点 | `Ctrl` + `?` | 直接为当前选中段创建「听不清 / 阻塞」疑点（行内 ⚑ 为先选类型再创建） |
| 退出编辑框 | `Esc` | |
| 快捷键面板 | 点顶栏「快捷键」 | F7/F8/F9 可改键，存于 localStorage |

输入法组合期间上述快捷键全部不触发；编辑框内空格永远是普通输入。

## 7. 已知限制 / 未达项（如实列出，无静态假 UI）

- **未实现（PRD 范围外或后置）**：批量导入与配对冲突页、拆分/合并/时间轴编辑、说话人、术语表、成稿层、VAD 覆盖候选、质量闸门与签署、版本快照/撤销历史、全文搜索、增强预设（增益/EQ）、脚踏板。
- **审计 UI 未实现（本轮明确范围外）**：富审计数据只经 `GET /api/projects/:id/audit-events` 与 SQLite 数据库提供，供 ground-truth 导出与机器预筛评估；界面不展示审计时间线。审计事件中的 `clientId` 是非实名客户端实例 ID，不代表经过认证的人。
- **播放位置持久化**：每 5 秒、暂停时、播放设置变化时写入；崩溃时最多回退约 5 秒的播放位置（校对文本的保存窗口是 500ms 且失败可见可重试）。「返回项目页 / 重新定位」前会强制落盘，失败留在工作台。
- **段尾暂停精度**：可见状态下由 rAF 检测（约 16ms，远优于 AC-043 的 100ms）；后台标签页 rAF 被浏览器节流，退化为 `timeupdate` 兜底（约 250ms），可能超出 100ms 口径——如实说明，不做虚假承诺。
- **循环不跨会话恢复**：A-B/整段循环是会话内临时状态，重启后需重新按 `Ctrl+L`。
- **非 Chrome 系浏览器（Firefox/Safari）**：无 File System Access——每次会话都需重新定位音频（有指纹/文件名+大小校验，旧项目首次重连需确认）；导出为下载模式（内存自检，无磁盘回读）；源文件保护退化为「请勿选择源文件」的提示而非自动阻止。
- **波形**：无整段波形图（3.5 小时 MP3 整段解码约需 2 GB+ 内存）；用字幕密度时间轴代替，播放、点击/拖动跳转、段状态着色、循环区、播放头可用。
- **列表渲染**：已移除 `content-visibility` 估算高度（其未渲染行尺寸估计会让原生滚动条 thumb 漂移、拖动时跟不上鼠标，第 8 轮审计按正确性优先移除）；1,676 段全量渲染初始开销略高但滚动几何稳定；PRD 的 50 万段级虚拟滚动属于 V1.0 性能项。
- **持久化边界**：项目、SRT、校对文本、确认状态、疑点和播放进度持久化在服务端 `data/tingproof.db`；清除浏览器站点数据不会删除服务端项目。源音频不上传，服务端数据目录仍需纳入主机备份。
- **项目删除为硬删除（V1.1.3）**：导入页「删除」二次确认后服务端项目业务数据立即移除且无法撤销（`delete_project` 审计行保留可追溯）；无回收站/软删除——该能力为 PRD 后续版本范围。
- **机器预筛需要服务端模型配置（V1.1.4）**：在服务端环境设置 `TINGPROOF_LLM_BASE_URL`（OpenAI-compatible 基地址，如本地 `http://127.0.0.1:11434/v1`）、`TINGPROOF_LLM_MODEL`、可选 `TINGPROOF_LLM_API_KEY`（本地无鉴权服务可留空）；未配置时入口显示「机器预筛未配置」，人工链路完全可用。模型适配器默认超时 60s、429/5xx/超时按 500ms/1500ms 退避重试两次。生产 provider/model 选型按 PRD C11 待真实联调确认；本轮自动化测试全部使用注入假模型，未对真实收费模型发起任何请求。
- **预筛范围与模型边界（V1.1.4）**：只筛未确认段的原始 ASR 文本（冻结于 run 创建时刻）；模型输出经严格白名单校验，非法候选拒绝并计数（不猜着落库）；机器建议是 warning 级疑点候选，不自动改稿、不自动确认、不代表已校对；提示词版本 `text-suspicion-v1`（任何提示词变化需提升版本）。
- **编码**：SRT 仅支持 UTF-8 / UTF-8 BOM；检测到非 UTF-8（U+FFFD）会警告。GB18030 自动检测是 PRD 3.1.7 的后续项。
- **旧版项目数据**：第 1 轮样机存入的音频 File 会在启动迁移中自动清除并尽量补齐指纹；正文已不可读的项目在首次重连音频时按「文件名+大小」核对，并要求用户确认建立身份（有明确提示，不静默、不锁死）。迁移为逻辑写回：Chrome 对解除引用的大 Blob 的磁盘回收可能延迟到浏览器关闭/重启（主审计方实测：旧 profile 约 96MB → 2.3MB，重启后 `navigator.storage.estimate().usage = 2,287,929` bytes，1,676 段与原始 SRT 完整，无任何 Blob 正文）；不承诺所有浏览器即时回收。
- **测试**：自动测试覆盖 SRT 解析/序列化/往返与边界、选中/确认策略、保存协调器（含执行中入队不丢写）、导航护栏、项目身份与音频指纹、v1→v2 迁移、持久化与重启恢复、幂等导入、原始层防覆盖、导出回读与空段阻塞、源文件保护三态、播放偏好应用、真实样本只读回归，以及服务端富审计（动作分类、before/after/changedFields、删除留痕、客户端来源、失败与语义 no-op 零事件、media 分阶段净 no-op 与 changedFields 不重复、跨项目与载荷内重复 issueId 对抗、canonical after、createdAt 不可变、issueCount 快照一致、分页与重启完整性、旧 7 列 schema 数据库原地无损迁移探针、未来 schema 版本拒绝打开、不兼容 schema 构造失败句柄零泄漏、损坏 JSON 明确失败）。真实 <audio> 全链路与 UI 手感无自动化测试，需按 §3 手工验证。

## 8. 下一轮最优先建议

1. 播放引擎与自动保存的端到端自动化（Playwright + Chromium）。
2. 字幕段拆分/合并与时间轴编辑（V0.5 P0），保持 original lineage。
3. GB18030 等编码检测与批量导入配对。
4. 「接受不可辨」签署流程与导出占位符规则。
5. 项目恢复包（JSON 导出/导入），用于服务迁移与离线备份。
