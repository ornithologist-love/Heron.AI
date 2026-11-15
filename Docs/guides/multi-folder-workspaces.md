---
type: guide
external: [dsh/]
---

# 多目录工作区

## 预设与界面入口

- **快速启动预设**：通过宿主控制接口自动载入并显示 Unreal 图标。开发编辑器默认包含“项目”和“引擎”两个目录（以项目目录为主要目录）；美术编辑器默认包含其主工程目录。独立 App 使用同一套编辑界面，在没有宿主推送时不自动发现 UE 预设。
- **编辑项目**：在侧栏工作区行打开「… → 编辑」可修改项目名称、添加或移除「源文件夹」（通过系统目录选择器，禁止选择盘符根目录，至少保留一个目录），并指定其中一个为「主要」文件夹。普通工作区与快速启动预设共用此入口，用户保存的目录配置不会被后续宿主同步覆盖。
- **移除项目**：点击「移除本地项目」仅取消本地注册，不会删除磁盘文件或对话记录；移除快速启动预设后，后台同步不会将其自动加回。

## 目录语义与写权限边界

- **主要文件夹与源文件夹**：主要文件夹决定新会话的默认起始目录（`cwd`）；已有会话保留原起始目录。在 `workspace-write` 模式下，DSH 文件编辑工具与同一条 PowerShell / bash 命令可写入当前工作区的所有源文件夹（其他工作区不受影响）。`read-only` 禁止文件修改，`danger-full-access` 保持原有全权限语义。
- **移除目录的历史归属**：移除某个源文件夹后，其已有会话仍归属于当前项目，但该目录不再享有写权限，也不能作为新会话的成员目录。
- **持久终端约束**：变更或删除目录前需先关闭或重置该工作区的持久终端，否则服务会拒绝更新目录集合。新启动的命令使用更新后的目录权限；已在运行的进程保持启动时的权限，不会中途撤销其 Windows Token。
- **持久化与多端同步**：目录配置保存在 `<stateDir>/dsh/heron-ai-workspaces.json`，仅已保存的配置参与权限解析（原生创建工作区框与 `@` 文件引用暂不支持多根检索）。手机端通过同一工作区 ID 保持多目录视图一致，聊天与工具执行仍在原桌面端完成（见 [手机远程接入](phone-remote-access.md#体验统一工作区)）。

## 实现与维护

多目录权限链参考 [Boy-Grid/dsh-multi-folder-workspace](https://github.com/Boy-Grid/dsh-multi-folder-workspace)，作为通用能力提交在 DSH 子模块（`dsh-workspace`、`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-sandbox-local`、`dsh-sandbox-windows-acl`）中，不使用旧版 npm 启动器或 JS 补丁；MIT 声明随 `dsh-sandbox-windows-acl` 包分发。

- **通用层与协议**：通用实现位于 `packages/common/runtime/src/heron-ai/workspaces/`，宿主推送协议见 [宿主接入 H5.1](../architecture/HOST-INTEGRATION.md#h51-宿主控制接口预设工作区)。
- **核心引擎接入**：DSH 通过 `sandboxPolicy.registerWorkspaceRoots()` 接收成员目录，通过 `workspaceRegistry.registerDirectories()` 解析新会话的主要目录与归属；文件工具复用 `writableRoots()`，进程沙盒为各平台生成多目录授权。
- **Windows 权限机制**：写身份基于排序后的真实目录集合派生（单目录保持原有身份）。目录集合变更后，新进程不再携带旧集合身份；已结束的旧集合残留 ACE 不会授权新进程，但已存活的旧进程需结束后才失去旧权限。所有目录与权限变更通过上下文快照记录，不修改工作区或 Session 的持久化格式。
