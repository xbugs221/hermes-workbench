# Hermes Workbench

[![CI](https://github.com/xbugs221/hermes-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/xbugs221/hermes-workbench/actions/workflows/ci.yml)

Hermes Agent Dashboard 工作台：会话、项目、看板、文件、技能、终端与 Codex 集成。
使用 Minecraft 工作台九宫格导航，提供统一的亮色与暗色主题。
通过 Hermes 插件 SDK 与独立后端集成，减少对 Hermes 主仓库的修改。

## 安装与升级

从 [Releases](https://github.com/xbugs221/hermes-workbench/releases) 下载版本包及 `SHA256SUMS`，
运行 `sha256sum --check SHA256SUMS` 校验。每个版本同时提供对应源代码。
具体加载器映射、后端配置和回滚见 [安装说明](docs/installation.md)。
这是 Hermes 扩展，不是可直接打开的独立静态网站。

## 开发

需要 Node.js 22+、package.json 指定的 pnpm，以及 Python 3.13 / uv。

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm typecheck
pnpm test
pnpm test:python
pnpm build
pnpm release:verify
pnpm release:package
```

源码位于 `dashboard/src/`，浏览器构建位于 `dashboard/dist/`。
Python 测试依赖锁定在 `requirements-dev.txt`。
本地更新依赖：`uv pip compile requirements-dev.in -o requirements-dev.txt`。

## 协作与版本

主分支为 `main`；通过 PR 合并，CI 检查通过后发布。
版本更新、正式版和预发布流程见 [发版说明](docs/releases.md)。
部署模板位于 `deploy/`；复制 `.env.example` 后填写自己的镜像、目录和身份配置。
模板不包含运行镜像、身份认证服务或个人凭据。

项目采用 [AGPL-3.0-only](LICENSE)。第三方组件见 [许可证说明](THIRD_PARTY_NOTICES.md)。

开发实例与正式实例的分离、完整手动更新及回滚流程见 [版本管理](docs/managed-releases.md)。
