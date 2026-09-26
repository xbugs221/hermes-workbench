# 开发端与用户端

## 开发实例：源码开发与实测

本地源码目录（例如 `/srv/hermes-workbench`） 可写挂载到 Hermes 的 `/opt/workbench-src`，
及 Workbench 容器的 `/opt/workbench`。智能体可编辑、运行类型检查、测试与构建。
在 Hermes 内运行 `python /opt/workbench-src/scripts/publish-dev.py /opt/workbench-src/dashboard`
将构建资源发布到自身实际插件目录，目标目录可通过 `--target` 指定。
薄加载器保持稳定，脚本核对已安装哈希并保留回滚备份；仍需验证登录后的真实 JS/CSS 和交互。
Python 后端源码修改后，等当前任务结束再重启 开发实例的 Workbench。禁止在执行任务时重启自身容器。

## 正式实例：独立正式版本

不挂载任何 Workbench 开发源码。用户数据、工作区、凭据与开发实例隔离。
`WORKBENCH_RELEASE_HOME=/opt/data/workbench` 启用完整更新模式：

```
/opt/data/workbench/
  bootstrap/             固定的进程监管器（管理员安装）
  releases/0.8.0/         已校验、只读的完整发行版本
    plugin/dashboard/    薄加载器、界面资源、manifest
    sidecar/dashboard/   配套后端与规范构建资源
    release.json         版本、commit、runtime_abi
    release-files.json   包内文件哈希
  current -> releases/0.8.0
  update.json            可恢复的更新状态
/opt/data/plugins/workbench/dashboard -> /opt/data/workbench/current/plugin/dashboard
```

在设置 → 版本切换查看 GitHub 正式版本及日志，只有点击后才下载。
下载校验 SHA256SUMS、版本、包内哈希和运行环境 ABI。拒绝路径穿越、链接成员及超限归档。
准备更新时拒绝新的写操作；有正在运行的 Codex 任务或终端连接则拒绝切换。
后台监管器只重启 Workbench API，不重启 Hermes 或 Codex App Server。
一个原子版本指针同时决定浏览器资源和后端目录；新后端健康版本匹配才报告成功。
启动失败切回原指针并重启原后端；容器在更新中退出，下次启动也优先恢复原版本。
界面会跨短暂断连轮询状态，失败显示回滚结果。更新期间主动刷新也能恢复状态跟踪。
旧完整版本目录保留，可在同一界面回退；0.7.x 的单独界面缓存不是完整版本回滚目标。

`runtime_abi=1` 表示当前基础 Python 环境与固定监管器协议。后续发行需保持兼容；
引入基础环境依赖或监管器协议破坏性变化时必须升 ABI，并安排一次管理员环境升级。
不能靠前端包隐式安装系统依赖、更新 Hermes 或重启整个容器。

## 首次迁移

1. 确认任务空闲；关闭各 Hermes 配置的 `sessions.auto_prune`。备份数据库、配置、凭据、
   sessions 转录与原始请求文件，保存原 Compose 和插件目录。
2. 从 GitHub Release 下载完整归档和 SHA256SUMS，校验发行来源和哈希。
3. 停止 正式实例的 Workbench；以管理员身份运行 `scripts/install-managed-release.py`，传入
   `--archive`、`--sha256`、`--version`、`--uid <数据目录所有者UID> --gid <共享组GID>`。首次迁移保留原 dashboard 备份。
4. 正式实例的 Workbench 使用 `bootstrap/combined_runtime.py` 启动，设置 `WORKBENCH_RELEASE_HOME`。
   删除 Workbench 开发源码挂载；正式实例的 Hermes 也移除 `/opt/workbench-src`、
   `/opt/data/workbench/source`、`/opt/data/plugin-sources/workbench` 的开发源码挂载。
5. 只重建需要更改挂载的 正式实例服务。核对镜像/身份/数据挂载、健康版本、插件链接、资产哈希、
   数据库原记录、转录文件和登录后的加载链路。失败恢复保存的 Compose/原插件目录。

发布仍由 GitHub Actions 完成，不连接部署主机，不自动安装；发布和用户更新是两步。
专用主机部署脚本不属于项目接口。部署命令、真实路径和身份信息保存在仓库外；正式实例不挂载开发源码。
