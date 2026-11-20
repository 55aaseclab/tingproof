# TingProof

English · [简体中文 · 完整操作和历史说明](README.zh-CN.md)

TingProof is a workspace for proofreading subtitles against an audio
recording. Import an MP3 and an SRT, listen to a segment, correct its text,
flag uncertain passages and export reviewed subtitles. The original
transcript stays read-only. Project data is shared by the configured
TingProof server. Select the original audio locally on each device.

## Getting started

Use Node 22.16 or later. Run `npm ci` and `npm run build` in this directory. Start with `TINGPROOF_DATA_DIR=/absolute/private/directory npm run serve`, then open http://127.0.0.1:5173/. The empty app accepts a local audio file and an SRT transcript. Its SQLite database stores project revisions in the configured private directory. For development use `npm run dev`. Run `npm test` for the synthetic suite.

[Product requirements](docs/PRD.en.md) · [Roadmap](ROADMAP.en.md) · [Business API](docs/BUSINESS_API.en.md)

## Praxis integration

The app-owned [provider contract](docs/PRAXIS-PROVIDER.md) supplies authorized source-backed cards and data-source metadata without exposing a new HTTP endpoint. Run `npm run test:provider` for the isolated provider checks.

## Praxis registration

App release: `0.1.7`. The app owns [`praxis-app.json`](praxis-app.json), its English and Simplified Chinese presentation, the icon at `public/praxis-icon.svg`, the declared PRD locations and any legacy icon aliases. `schemaVersion: 1` identifies the registration format; it is separate from this app release and from data, protocol and document revisions. Package and lockfile release metadata, where present, agree with the declaration.

[`apps.example.json`](apps.example.json) registers a local alias by referencing `./praxis-app.json` and `http://127.0.0.1:5173/`. Start the standalone service described above before using the example; registration does not start a backend or grant account, administrator or business-data access. Installation origins, data locations and access policy remain separately configured.

## App-owned container build

`Dockerfile.praxis` builds this application from its own repository, without a Praxis checkout or an external build context:

```sh
docker build -f Dockerfile.praxis -t praxis-tingproof:local .
```

Use the application configuration and persistent data locations documented above when running the image. The Praxis installation consumes the same app-owned build and deployment declaration.

## 应用自有容器构建

`Dockerfile.praxis` 可直接从本应用仓库构建，无需 Praxis 源码或额外构建上下文：

```sh
docker build -f Dockerfile.praxis -t praxis-tingproof:local .
```

运行镜像时沿用上文的应用配置与持久数据位置。Praxis 安装流程使用同一份应用自有构建文件与部署声明。
