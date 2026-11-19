# TingProof 受控业务接口

[English](BUSINESS_API.en.md) · 简体中文


需求版本 V1.1.9，应用版本0.1.3。接口由独立应用自身实现，平台只通过 HTTP 调用；不导入 Praxis 源码，不运行内部 agent。

## 配置与入口

- `TINGPROOF_MANAGED=1`：封闭原 `/api/*` 路径，只允许经过签名的 `POST /api/business`。静态页面仍可访问，旧全项目网页不能作为任务访客入口；平台提供受限任务呈现。
- `TINGPROOF_BUSINESS_KEY_FILE`：Git 外应用专用密钥普通文件，至少32字节，权限0600或0400。按原始字节使用，不去除换行、不做hex/base64解码。受控模式缺密钥时启动失败，不能退回无认证模式。
- `TINGPROOF_LEGACY_SPACE_ID`：管理员明确指定旧单用户项目库的归属空间。未绑定项目只允许在该空间创建任务；未配置时不能通过首次请求认领旧项目。配置不代表授权用户，也不代替平台的成员/客户端判定。
- 独立单用户模式保留原有工作流。切换受控模式与真实schema迁移需要按平台交付流程执行；本轮维护测试只用临时合成数据库。

## 请求与签名

请求为JSON对象：`{operation,spaceId,resourceId,input?,expectedRevision?,idempotencyKey?}`。额外字段拒绝。ID为1–80位英文字母、数字、下划线或连字符；幂等键为1–128位，另允许句点和冒号。

`x-praxis-assertion` 为 `base64url(JSON claims) + '.' + base64url(HMAC-SHA256(payload, key))`。claims包含：

`{v:1,appId:'tingproof',userId,clientId,grantId,spaceId,action,resources,expiresAt,requestId,method:'POST',path:'/api/business',bodyHash}`。

`bodyHash` 是原始HTTP正文的SHA256十六进制摘要；`expiresAt` 是Unix毫秒，必须仍有效且距当前不超过30秒。应用、身份字段、空间、动作、资源、HTTP方法与精确路径均校验。平台每次调用前重新验证当前用户、客户端和授权；应用额外检查任务到期/撤销。签名密钥不交给用户或模型。

## 操作契约

| operation | action | resourceId与input | 结果 |
|---|---|---|---|
| `list_assignments` | `read` | `resourceId:'assignments'`；input省略或空对象 | `{assignments:[{id,title,status,revision,expiresAt}],cursor}`；仅当前空间和资源范围的有效任务，无正文/项目ID |
| `get_assignment` | `read` | 任务ID；input省略或空对象 | `{assignment:{id,spaceId,title,status,expiresAt},revision,cursor,segments:[...]}`；仅任务分配段，无projectId/SRT/媒体/其他片段/疑点或全项目审计 |
| `create_assignment` | `assign` | 新任务ID；`input:{projectId,segmentIds:[...],title?,expiresAt?}`；签名资源必须含`*` | 任务摘要、revision、cursor、`replayed`；不返回片段正文 |
| `submit_corrections` | `submit` | 任务ID；`input:{corrections:[{segmentId,correctedText,status?}]}` | 任务摘要、revision、cursor、`replayed`，仅本次提交段的segmentId/correctedText/status/revisionNo，不返回原文或未提交段 |
| `revoke_assignment` | `assign` | 任务ID；input省略或空对象 | 撤销后的任务摘要、revision、cursor、`replayed`；不返回片段正文 |
| `events` | `read` | `resourceId:'events'`；`input:{after?:number}` | `{events:[{id,cursor,resourceId,revision,operation,requestId,committedAt}],cursor,minCursor:0}`；仅当前空间及资源范围的脱敏提交事件 |

所有写操作必须携带`expectedRevision`与`idempotencyKey`；revision是原项目当前版本，创建/撤销任务不增加项目内容版本，校正复用原有段更新与确认规则。不同任务修改同项目时可能产生项目级版本冲突，调用者须重新读取并让用户处理，不能自动覆盖。

`status`支持`unreviewed/editing/questioned/confirmed/accepted_unclear`；省略时保留现状。确认操作仍原子解决该段open疑点。整批片段必须属于同一任务且不重复；未知字段、原文/时间轴篡改、跨任务片段、非法状态或旧版本使整批失败。

所有写入、可信主体审计、事件与幂等结果同事务提交。幂等按用户、客户端、授权及键隔离；同键同语义请求返回原结果并标记`replayed:true`，重启后仍生效。同键异参409；任务到期/撤销后禁止借历史结果回放读取。撤销操作本身可以幂等重试。

受控事务执行全部业务与元数据写入后，在最终SQLite COMMIT前再次复核签名期限；到期403且全部回滚。入口验签或较早的检查不能代替这一最终检查。

事件按提交ID递增，每批最多100项，cursor为本批最后返回事件位置，无事件时保持传入游标。上层持续拉取直到空批，不得跳到全局最新而漏掉中间提交。事件无私人正文、原始身份或凭据；内部可信主体存于受保护审计，不对任务访客开放。事件当前不自动裁剪，`minCursor:0`。

## 错误与验证

400表示无效输入，403表示签名或权限拒绝，404统一表示任务不可用，409表示版本或幂等冲突；响应不输出内部路径、原始异常或私人正文。所有旧API、别名、SRT、富审计、预筛、迁移与删除在受控模式均拒绝直接访问。

本轮自动验证覆盖真实HTTP、临时SQLite、任务隔离、请求绑定、旧API拒绝、确认规则、晚失败回滚、持久幂等、撤销/到期、事件过滤/分页及schema3无损升级。真实数据库迁移、受限外部业务agent与手机验收由平台另行记录，不能用本轮自动测试替代。
