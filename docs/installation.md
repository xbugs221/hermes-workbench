完整用户版安装与升级请优先按 [开发与用户版管理](managed-releases.md) 操作。以下为开发端和旧版本的手动文件布局说明。

# 安装布局

发行包包含 `plugin/`、`sidecar/`、主题与扩展。先解压到临时目录并校验哈希，再备份目标目录。
需要已有 Hermes Dashboard（插件 SDK 1.1.0）与 Python 后端环境；Codex 集成还需要配置 app-server。

将 `plugin/` 内容安装到 Hermes 的 `plugins/workbench/`。其 dashboard/dist 中：

- index.js / style.css 是稳定薄加载器。
- workbench.js / workbench.css 是本版本实际界面资源。
- mermaid.min.js 是本地流程图资源。

不要把源码构建的 dashboard/dist/index.js 直接覆盖插件的 index.js。
后端使用 `sidecar/dashboard/`，保留其中原始 dist/index.js 与 style.css 路径。
Python 依赖可从 requirements-dev.txt 安装（该文件也包含验证工具）。
按宿主环境配置 HERMES_WORKBENCH_* 与 CODEX_APP_SERVER_* 环境变量；参考 dashboard/sidecar_app.py
及 [通用部署模板](../deploy/README.md)。运行前必须填写自己的配置。
宿主 Hermes、认证代理和 Codex 服务不包含在发行包中。

升级时保证插件目录共享组可写；先备份，原子替换资源，核对安装前后哈希。
必须从真实 Dashboard 入口验证 JS/CSS 正文、Content-Type 和哈希，登录页的 HTTP 200 不算成功。
随后检查亮暗主题、会话和主要交互。回滚时恢复对应版本整个目录，并重新验证入口。

主题文件使用 `workbench-light` / `workbench-dark` 标识。将 `theme/*.yaml` 安装到宿主的 Dashboard 主题目录，将 `theme/skins/*.yaml` 安装到 TUI skin 目录；升级旧主题时重新选择一次亮/暗模式。
