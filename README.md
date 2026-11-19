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
