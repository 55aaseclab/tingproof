# Praxis integration

This application owns the fixed `praxis-integration.mjs` entry and the modules in this directory. Praxis loads the reviewed code selected by its installed source index. Application behavior, native interfaces and data remain in this repository.

The declaration supplies native entry and route policy, source assets, storage and deployment recipes. A supported business section also supplies typed operations, MCP tools, localized guidance and validation. The companion `praxis-provider.mjs` supplies authorized cards and data inventory. Registration describes existing capabilities; effective user and client permissions still come from the installation.

Business callbacks receive authorization facts and bound read callbacks. Core retains authentication, resource checks, policy leases, request signing, idempotency routing and structured traces. Application assertion fields use declared authorization primitives; tokens, signing keys and the authorization store are not callback arguments. An operation's authorization action and whether it mutates data are separate declarations.

Storage and deployment helpers run in the operator workflow. Private origins, accounts, keys, directories, mounts and business records stay in installation configuration and data, outside this source tree. Native container builds use this application's `Dockerfile.praxis` where declared; static readers use their declared platform assets.

The declaration schema version remains `1`. The app release is the three-component version in `praxis-app.json`, matching package and lock metadata when present.

## 简体中文

本应用维护固定入口 `praxis-integration.mjs` 及本目录中的集成模块。Praxis 从安装索引选定、经审核的源码加载它们。应用行为、原生界面与数据继续归所属仓库维护。

声明提供原生入口与路由策略、源码资源、存储及部署配方；已支持的业务部分还提供类型明确的操作、MCP 工具、本地化指引和校验。配套 `praxis-provider.mjs` 提供获授权的卡片及数据清单。登记描述已有能力，用户和客户端的有效权限仍由安装环境决定。

业务回调仅接收授权事实及限定范围的读取回调；Core 继续执行身份认证、资源检查、策略租约、请求签名、幂等路由与结构化轨迹。应用签名字段使用已声明的授权原语，回调参数不包含令牌、签名密钥或授权存储。操作所需的权限动作与是否修改数据分别声明。

存储及部署辅助模块在运维流程运行。私有来源、账号、密钥、目录、挂载和业务记录保存在安装配置及数据中，不进入源码。声明了原生容器的应用使用自己的 `Dockerfile.praxis`，静态阅读器使用其声明的平台资源。

声明的 schema 版本仍为 `1`。应用发行版使用 `praxis-app.json` 中的三段版本号，并与存在的 package、lock 元数据保持一致。
