# Changelog

版本采用 SemVer；后续每个 GitHub Release 自动整理两次标签间的 PR 与提交。

## 0.8.2

- Sanitize repository history, author metadata and legacy deployment references.
- Retire older tags and release archives; new installs should use this release.
- Reject reintroduction of retired history in CI. Existing clones must be replaced or carefully migrated without merging old history.
- Runtime source is unchanged from 0.8.1; this release updates repository hygiene and provenance.

## 0.8.1

- Remove instance-specific deployment configuration and historical session identifiers; add parameterized single-instance templates.
- Replace personal locale and theme identifiers with Workbench identifiers. Install the included `theme/workbench-*.yaml` and `theme/skins/workbench-*.yaml` in the host before using the new theme toggle; existing dark/light preferences are recognized.
- Configure release repositories, plugin paths and credential imports explicitly; preserve existing per-instance credentials.
- Add a public-content CI check and editor/theme/credential regression coverage.
- Include reviewed dependency updates and the chat file-preview fixes.
- Historical tags and release archives are unchanged by this source update.

## 0.8.0

- Managed installations switch matching frontend/backend versions atomically with health checks and rollback.
- Keep source development and independently installed releases separate; updates remain user-selected.

## 0.7.1

- 版本选择改为 SemVer 降序，正确排列 codex.14 与 codex.9。
- 合并 GitHub Releases 与本地缓存，显示当前版本、预发布与更新日志。
- 仅在用户点击时下载并校验界面资源，保留旧版用于回退，失败恢复原资源。
- 网络故障保留本地版本，前端提示失败并支持重试；不自动部署或重启服务。
- 首次接入需要升级更新器后端；旧实例不会因发布 Release 自动更新。

## 0.7.0

- 将 Workbench 迁移至独立 GitHub 仓库，保留 Git 历史。
- Minecraft 九宫格导航与全局亮暗主题。
- 会话恢复、图片粘贴、看板上下文与实时连接改进。
- 统一版本来源，增加完整 CI、版本 PR、发布归档及 SHA-256 校验。
- 项目许可证统一为 AGPL-3.0-only；第三方许可证保留。
