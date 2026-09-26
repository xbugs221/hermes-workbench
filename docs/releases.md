# Versioning and releases

`package.json` 是版本来源；`scripts/version.py` 同步 Hermes manifest，前端直接导入该版本。
格式采用 SemVer；破坏性变更升主版本、功能升次版本、修复升补丁版本。
预发布采用 `0.8.0-rc.1`（或 alpha / beta）。已发布标签不可移动或覆盖，修复必须升版。

1. Actions → Prepare release → 输入新版本，自动创建版本 PR 并显式触发 CI。
   首次需在仓库 Actions 设置允许 GitHub Actions 创建 PR。
   也可以本地 `pnpm version:set 0.7.1`，提交两处版本文件并创建 PR。
2. CI gate 通过后合并。补充重大变更或升级注意事项到 CHANGELOG.md。
3. 更新本地 main，然后 `git tag -a v0.7.1 -m 'Release v0.7.1'`，`git push origin v0.7.1`。
4. Release 流水线验证标签与版本一致、提交属于 main，重新运行全量测试后发布。
   正式版本与预发布自动区分；发布说明自动生成，附件包括插件包、源码包和 SHA256SUMS。

CI 仅构建和验证；不连接部署主机，也不自动重启生产服务。
包内 release.json 记录版本与源码提交。回滚采用旧版归档，先备份并核对实际加载路径。
若流水线失败，修复后发布新版本；尚未创建 Release 的原标签可通过 Actions 重跑。

推荐 main 分支保护：禁止强推和删除，要求 CI gate 通过，启用 squash merge 并删除已合并分支。
不要把令牌写入仓库。流水线使用短期 GITHUB_TOKEN；日常维护用 gh auth login 授权。

## 用户手动更新

0.8.0 起，正式实例的完整更新模式一次切换配套前后端，健康失败自动回滚。
开发实例保持源码开发模式，界面更新仅作用于开发端浏览器资源。
初次启用需要一次管理员迁移；现有 0.7.x 的界面更新器不会自动改为完整更新。
模式、布局、升级范围和操作步骤见 [开发与用户版管理](managed-releases.md)。
发布 Release 不触发 主机部署或用户更新。
