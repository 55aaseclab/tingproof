# 听校 TingProof

[English](README.md)

听校提供同源音频校订工作台。导入音频和 SRT，逐段回听、修订并导出字幕。数据目录由运营者提供，应用初始为空。

使用 Node 22.16 或更新版本执行 `npm ci`、`npm run build`，然后执行 `TINGPROOF_DATA_DIR=/绝对路径/私有目录 npm run serve`。打开本机 5173 端口。使用 `npm test` 运行合成测试。

[产品需求](docs/听校_PRD_V1.0.0.md) · [路线图](ROADMAP.md)

## Praxis 集成

应用维护的[供数合同](docs/PRAXIS-PROVIDER.md)提供按授权过滤、有来源依据的卡片与数据源描述，不增加 HTTP 元数据入口。使用 `npm run test:provider` 验证隔离供数测试。
