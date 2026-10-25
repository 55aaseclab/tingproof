# 听校（TingProof）V0.1 纵向样机（第 5 轮返修版）

由服务端项目空间承载、可从多个设备访问的长音频人工听校工作台——最小完整闭环：

> 导入 MP3 + SRT → 边听边校（播放 / 变速 / 自动回退 / 循环）→ 自动保存与恢复 → 标记疑点 → 导出 SRT 并回读校验。

对应 [`docs/听校_PRD_V1.0.0.md`](docs/听校_PRD_V1.0.0.md) 的 V0.1 范围（PRD 2.4：单文件纵向样机）。

产品文档均随独立仓库保存在 `docs/`：

- [产品需求文档（PRD）](docs/听校_PRD_V1.0.0.md)
- [待确认项清单](docs/听校_待确认项清单_V1.0.0.md)
- [Q4 版本路线图](docs/1025-Q4路线图.html)

第 3–5 轮审计已全部完成并纳入本版，要点：

- **第 3 轮（数据与行为）**：v1→v2 数据迁移（清除遗留音频正文并补指纹）、保存协调器丢写修复、导航/重定位前强制落盘、播放速率真实恢复、暂停即时持久化、旧项目音频重连策略、界面纯白底；
- **第 4 轮（并发与依赖）**：SaveCoordinator 并发 flush 改为 join 语义、播放→选中订阅只依赖稳定引用（纯 render 不覆盖显式选中）、周期持久化计时器不随 render 重置；
- **第 5 轮（真实浏览器布局验收）**：≤1100px/900×900 下列表与疑点栏上下分区、互不重叠、各自独立滚动；内联 data URI favicon 消除 /favicon.ico 404。

逐轮明细与测试证据见 §5。

---

## 1. 环境要求

- Node.js ≥ 22.13（服务端使用内置 `node:sqlite`；本轮使用 Node 24.22 验证）
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

### 本轮已自动化验证的结果（2026-10-25，Node 24.22）

| 命令 | 结果 |
| --- | --- |
| `npm run lint`（tsc + eslint） | 通过，0 错误 |
| `npm test` | 30 个文件 **254 个用例全部通过**（含既有播放/编辑/疑点/确认/滚动回归，以及服务端双客户端共享、重启持久化、409 冲突、幂等迁移和 0.0.0.0 配置） |
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
5. 逐段播放（PRD V1.0.2）：点击任一行非操作区域或聚焦其文本框 → 若在播放先暂停，选中该段并精确定位到段首（不自动播放）；
   行内「▶ 播放」→ 从该段段首播放，再次点击「⏸ 暂停」停在当前位置（不回段首）；到段尾自动暂停并稳定在段尾，绝不串入下一段；
   同段段内恢复按自动回退且不早于段首；双击时间码等价于该行播放/暂停开关；
   `F8`/底部播放按钮 = 当前段范围感知播放/暂停；`F7`/`F9` 后退/前进 2 秒且钳制在当前段内；
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
11. 源文件安全验证：任意时刻执行
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
│  ├─ remoteRepo.ts   生产/dev 服务端 API 仓库（revision/409/不可达保护）
│  ├─ repo.ts         仓库门面（按环境选择 remote；测试/迁移显式使用 IndexedDB）
│  ├─ idbRepo.ts      旧 IndexedDB 适配器（仅测试与迁移来源）
│  ├─ db.ts           旧适配器连接管理（4 个 object store）
│  ├─ saveCoordinator.ts  保存协调器（去重、防抖、失败保留队列可重试、状态可订阅）
│  └─ types.ts        三层文稿数据模型（V0.1 实现前两层）
├─ src/audio/usePlayer.ts   播放引擎（rAF 时钟、变速不变调、自动回退、A-B/整段循环）
└─ src/ui/        导入页 / 工作台 / 片段列表 / 时间轴 / 疑点面板 / 导出对话框 / 改键面板
```

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
9. **逐段播放与选中/确认策略**（可解释、有测试，PRD V1.0.2）：普通播放只允许当前选中段 `[start_ms, end_ms)`——到 end_ms 自动暂停并把位置稳定在段尾（rAF 主检测 + timeupdate 兜底，段尾分支不再排帧）；循环 region 是唯一「段尾回段首继续」模式且仅当 region 与当前段一致时生效，换段时旧循环自动解除；行内按钮是播放/暂停开关（播放中点击停在当前位置，不回段首；同段段内恢复自动回退不早于段首；换段/段尾/段外从段首开始）；点击行/聚焦文本框 = 选中 + 精确定位 startMs + 暂停旧段（不自动播放）；`Ctrl+Enter` 确认后定位下一未校对段段首（不自动播放）；已确认段再次点击同一按钮为「↶ 取消确认」——
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
| 播放 / 暂停（当前段） | `F8` 或底部按钮 | 范围感知：播放中暂停在当前位置（不回段首）；同段段内恢复自动回退（不早于段首）；段尾/段外从段首 |
| 后退 2 秒 | `F7` | 钳制在当前段内 |
| 前进 2 秒 | `F9` | 钳制在当前段内 |
| 上一段 / 下一段 | `Alt` + `←` / `→` | 选中并精确定位到段首；正在播放先暂停 |
| 确认当前选中段并前进 | `Ctrl` + `Enter` | 定位下一未校对段段首，不自动播放 |
| 确认 / 取消确认（行内按钮） | — | 只作用于被点击的段，与播放位置无关；已确认段再次点击即撤销确认 |
| 选中某段 | 点行非操作区域 / 聚焦该行编辑器 | 精确定位到该段 startMs；不自动播放；人工滚动列表即暂停跟随，显式定位/播放或「回到播放点」恢复 |
| 播放 / 暂停（行内开关） | 点行内 `▶ 播放` / `⏸ 暂停` | 双击时间码等价；按钮文案与可访问名称随状态切换 |
| 循环当前段 | `Ctrl` + `L` 或行内 `⭯ 循环` | 再按一次解除；唯一的段尾回段首继续模式；换段自动解除旧循环 |
| 创建疑点 | `Ctrl` + `?` | 直接为当前选中段创建「听不清 / 阻塞」疑点（行内 ⚑ 为先选类型再创建） |
| 退出编辑框 | `Esc` | |
| 快捷键面板 | 点顶栏「快捷键」 | F7/F8/F9 可改键，存于 localStorage |

输入法组合期间上述快捷键全部不触发；编辑框内空格永远是普通输入。

## 7. 已知限制 / 未达项（如实列出，无静态假 UI）

- **未实现（PRD 范围外或后置）**：批量导入与配对冲突页、拆分/合并/时间轴编辑、说话人、术语表、成稿层、VAD 覆盖候选、质量闸门与签署、版本快照/撤销历史、全文搜索、增强预设（增益/EQ）、脚踏板。
- **播放位置持久化**：每 5 秒、暂停时、播放设置变化时写入；崩溃时最多回退约 5 秒的播放位置（校对文本的保存窗口是 500ms 且失败可见可重试）。「返回项目页 / 重新定位」前会强制落盘，失败留在工作台。
- **段尾暂停精度**：可见状态下由 rAF 检测（约 16ms，远优于 AC-043 的 100ms）；后台标签页 rAF 被浏览器节流，退化为 `timeupdate` 兜底（约 250ms），可能超出 100ms 口径——如实说明，不做虚假承诺。
- **循环不跨会话恢复**：A-B/整段循环是会话内临时状态，重启后需重新按 `Ctrl+L`。
- **非 Chrome 系浏览器（Firefox/Safari）**：无 File System Access——每次会话都需重新定位音频（有指纹/文件名+大小校验，旧项目首次重连需确认）；导出为下载模式（内存自检，无磁盘回读）；源文件保护退化为「请勿选择源文件」的提示而非自动阻止。
- **波形**：无整段波形图（3.5 小时 MP3 整段解码约需 2 GB+ 内存）；用字幕密度时间轴代替，播放、点击/拖动跳转、段状态着色、循环区、播放头可用。
- **列表渲染**：已移除 `content-visibility` 估算高度（其未渲染行尺寸估计会让原生滚动条 thumb 漂移、拖动时跟不上鼠标，第 8 轮审计按正确性优先移除）；1,676 段全量渲染初始开销略高但滚动几何稳定；PRD 的 50 万段级虚拟滚动属于 V1.0 性能项。
- **持久化边界**：项目、SRT、校对文本、确认状态、疑点和播放进度持久化在服务端 `data/tingproof.db`；清除浏览器站点数据不会删除服务端项目。源音频不上传，服务端数据目录仍需纳入主机备份。
- **编码**：SRT 仅支持 UTF-8 / UTF-8 BOM；检测到非 UTF-8（U+FFFD）会警告。GB18030 自动检测是 PRD 3.1.7 的后续项。
- **旧版项目数据**：第 1 轮样机存入的音频 File 会在启动迁移中自动清除并尽量补齐指纹；正文已不可读的项目在首次重连音频时按「文件名+大小」核对，并要求用户确认建立身份（有明确提示，不静默、不锁死）。迁移为逻辑写回：Chrome 对解除引用的大 Blob 的磁盘回收可能延迟到浏览器关闭/重启（主审计方实测：旧 profile 约 96MB → 2.3MB，重启后 `navigator.storage.estimate().usage = 2,287,929` bytes，1,676 段与原始 SRT 完整，无任何 Blob 正文）；不承诺所有浏览器即时回收。
- **测试**：自动测试覆盖 SRT 解析/序列化/往返与边界、选中/确认策略、保存协调器（含执行中入队不丢写）、导航护栏、项目身份与音频指纹、v1→v2 迁移、持久化与重启恢复、幂等导入、原始层防覆盖、导出回读与空段阻塞、源文件保护三态、播放偏好应用、真实样本只读回归。真实 <audio> 全链路与 UI 手感无自动化测试，需按 §3 手工验证。

## 8. 下一轮最优先建议

1. 播放引擎与自动保存的端到端自动化（Playwright + Chromium）。
2. 字幕段拆分/合并与时间轴编辑（V0.5 P0），保持 original lineage。
3. GB18030 等编码检测与批量导入配对。
4. 「接受不可辨」签署流程与导出占位符规则。
5. 项目恢复包（JSON 导出/导入），用于服务迁移与离线备份。
