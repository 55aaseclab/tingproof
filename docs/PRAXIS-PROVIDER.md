# Praxis provider / 工作台供数合同

## English

`describe()` returns version 1, the catalog app ID, read-operation/native-path allowlists and app-owned data-source descriptors. `getCards(context)` and `getDataInventory(context)` return `{status, items, errors?}`. Status is `ready`, `empty`, `partial`, `unavailable` or explicitly `unsupported` when the app does not implement a capability. An unavailable service never becomes a successful empty state.

The host supplies `spaces: string[]`, `actor: {userId, username}`, and `invoke({spaceId, operation, resourceId?, input})`. Each invocation uses the existing resource-filtered read contract; the host rechecks authority before delivering results. It cannot execute writes. Finance and Intelligence instead declare their existing whole-native-view permission boundary and fixed `readNative({path, resourceId})` routes. These are not fine-grained delegated MCP resources.

Cards retain stable app/space/object IDs and real revisions or stable source-content hashes, app-native links, source-backed previews and authorized evidence. The provider does not generate briefs or change deadlines, assignments or completion. Missing source text has no fabricated preview. Projects only returns unfinished work explicitly assigned to the current user ID or username. The host owns user-private Later/Hide state.

`resolveDataSource(descriptor)` resolves only a descriptor declared by this app against actual runtime environment and mount metadata. `location.env` names a non-secret data-location variable; `relative` names an app-relative child. `map: "spaces"` expands only path values from the private space-file map, with optional literal `suffix` for its artifact directory. `working-directory`, `browser` and `browser-file` identify distinct storage ownership; a browser file is not claimed covered by server backup. Return unresolved locations honestly, never a guessed path. Descriptors and results never include signing-key variables, credentials, data bodies or recovery keys. Inventory is administrator-only metadata.

There is no new public HTTP metadata route. The module is loaded by a trusted host and has no direct filesystem, environment, credential, fetch or store access. Host callbacks enforce same-origin/native authentication or the existing signed service boundary. Runtime packaging must include this source module; no video backend is installed or invoked. Test with `npm run test:provider` and the owning native suite. All committed fixtures are fictional.

## Native assignment entry

`/apps/tingproof/?space=<space>&assignment=<id>` opens the native assignment reader through the first-party session and the existing scoped `get_assignment` operation. Display authorized original/corrected text, timing and status. Assignment read access does not permit whole-project reads, export, corrections or source-audio download. Local audio selection remains in memory on this device, without upload. Access loss clears the assignment.

## 简体中文

`describe()` 提供版本 1、正式目录应用 ID、只读操作与原生路径允许列表以及应用自己的数据源描述。`getCards(context)`、`getDataInventory(context)` 返回 `{status, items, errors?}`，区分正常、有意义的空态、部分失败、不可用与明确不支持。

宿主提供已授权的 `spaces`、当前 `actor` 和限定到本应用的 `invoke`；每次调用沿用所属应用的资源过滤读取合同，交付结果前再次验权，不能执行写入。Finance、Intelligence 使用固定原生只读路径及既有整视图权限粒度，不伪装成按记录委托的 MCP 能力。

卡片保留稳定对象 ID、真实版本或内容摘要、原生对象链接、原文预览和已授权证据，不生成虚构简报，不改变截止时间、分配或完成状态。Projects 只显示明确分配给当前用户的未完成工作。稍后查看、隐藏版本由宿主管理为本人私有偏好。

`resolveDataSource` 只解析本应用声明的数据位置，结合真实运行环境与挂载，绝不推测目录。`env` 表示非密钥的数据位置变量，`relative` 为相对子路径；`map: "spaces"` 只展开私有配置中的路径映射，`suffix` 标识对应附件目录。运行工作目录、浏览器记录和本地文件分别说明；浏览器源录音不冒充服务端备份覆盖。库存仅供管理员查看，不含密钥、凭据、恢复材料或业务正文。

模块不增加公开 HTTP 路径，也不直接访问文件、环境变量、存储或网络。宿主负责原生会话或既有签名服务验权。运行镜像需包含模块，不安装或调用视频后端。使用 `npm run test:provider` 与原生测试验证，夹具全部为虚构资料。

原生任务入口 `/apps/tingproof/?space=<space>&assignment=<id>` 使用本人会话和既有按资源授权的 `get_assignment`，展示获授权的原文、校正稿、时间和状态。任务读取不授予整项目读取、导出、校正或原始录音下载。选择本机录音仅保留会话内存、不上传；失去权限时清空任务。

When only the app namespace is known, retain `applicationPath`; do not label it as a host or container path without a verified binding.

只知道应用内位置时保留 `applicationPath`；没有核验绑定时，不将它标作宿主机或容器路径。
