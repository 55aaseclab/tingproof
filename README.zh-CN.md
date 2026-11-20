# 听校 TingProof

[English](README.md)

听校提供同源音频校订工作台。导入音频和 SRT，逐段回听、修订并导出字幕。数据目录由运营者提供，应用初始为空。

使用 Node 22.16 或更新版本执行 `npm ci`、`npm run build`，然后执行 `TINGPROOF_DATA_DIR=/绝对路径/私有目录 npm run serve`。打开本机 5173 端口。使用 `npm test` 运行合成测试。

[产品需求](docs/听校_PRD_V1.0.0.md) · [路线图](ROADMAP.md)

## Praxis 集成

应用维护的[供数合同](docs/PRAXIS-PROVIDER.md)提供按授权过滤、有来源依据的卡片与数据源描述，不增加 HTTP 元数据入口。使用 `npm run test:provider` 验证隔离供数测试。

## Praxis 登记

应用发行版本：`0.1.7`。本应用维护 [`praxis-app.json`](praxis-app.json)、英中展示文案、`public/praxis-icon.svg` 图标、PRD 路径及需要保留的旧图标别名。`schemaVersion: 1` 表示登记格式，与应用发行版本、数据、协议和文档修订分别管理；已有 package 和 lockfile 的发行版本须与声明一致。

[`apps.example.json`](apps.example.json) 引用 `./praxis-app.json`，使用 `http://127.0.0.1:5173/` 登记本地别名。先按上文启动独立服务；登记不启动后端，也不授予账号、管理员或业务数据权限。安装地址、数据位置与授权策略仍独立配置。
