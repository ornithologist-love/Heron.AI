---
type: guide
external: [dsh/]
---

# 多目录工作区

快速启动预设通过宿主控制接口自动载入，并显示 Unreal 图标。开发编辑器默认包含项目与引擎两个目录，以项目为主要目录；美术编辑器默认包含 TSEditor 目录。独立 App 使用同一套项目编辑功能；没有宿主推送时不发现 UE 预设。

在侧栏工作区行的「… → 编辑」打开「编辑项目」。顶部修改项目名；「源文件夹」中可添加、移除文件夹，并选择一个作为「主要」。添加文件夹使用系统目录选择器，不需要手输路径。保存时解析真实路径，至少保留一个源文件夹，并拒绝盘符根目录。此入口同时支持普通工作区和快速启动预设；已保存的目录选择不会被后续宿主同步覆盖。

主要文件夹决定新会话的起始目录。已有会话保留原来的 cwd 与记录；沙盒写范围使用保存后的源文件夹集合。底部「移除本地项目」仅移除本地注册，文件与对话记录保留；移除快速启动预设后，后台同步不会把它自动加回。

移除源文件夹时，其已有会话仍归属于这个项目。历史目录只用于确认已有会话的归属，不参与写权限，也不能作为新会话的成员目录。

在 `workspace-write` 模式下，DSH 文件编辑工具和同一条 PowerShell / bash 命令均可写入当前工作区的全部成员目录。其他工作区不会自动加入权限集合。`read-only` 仍禁止文件修改，`danger-full-access` 沿用原有含义。DSH 原有的读取、网络与临时目录规则保持其底座语义。

修改或删除预设关联目录前，需要关闭或重置该工作区的持久终端；服务会拒绝在持久终端仍存活或正在创建时更换目录集合。新启动的命令使用保存后的成员集合；已经运行的命令保留启动时的权限，不会通过变更配置撤销其 Windows token。

目录记录保存在产品状态目录内的 `dsh/heron-ai-workspaces.json`，只有已提交的记录参与权限解析。原生工作区身份与会话格式不变；模型上下文记录完整成员集合。原生创建工作区的目录选择框与 `@` 文件引用没有改成多根检索。

手机统一入口沿用同一工作区 ID、成员目录与主要目录，多目录仍显示为一个项目。远程导航优先读取所属 Host 的原生会话归属，聊天与工具执行保留在原 Host；接入日常桌面实例的方式见 [手机远程接入](phone-remote-access.md#体验统一工作区)。

## 维护

多根权限链参考 [Boy-Grid/dsh-multi-folder-workspace](https://github.com/Boy-Grid/dsh-multi-folder-workspace)，作为通用功能提交在 DSH 子模块（`dsh-workspace`、`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-sandbox-local`、`dsh-sandbox-windows-acl`），不使用其旧版 npm 启动器或发布 JS 补丁。MIT 声明随 `dsh-sandbox-windows-acl` 包分发。

通用层实现位于 `packages/common/runtime/src/heron-ai/workspaces/`，宿主推送协议见 [宿主接入 H5.1](../architecture/HOST-INTEGRATION.md#h51-宿主控制接口预设工作区)。

底座通过 `sandboxPolicy.registerWorkspaceRoots()` 接受产品提交的成员目录，通过 `workspaceRegistry.registerDirectories()` 解析新会话的主要目录及成员归属。文件工具复用 `writableRoots()`；进程沙盒为各平台生成多目录授权。Windows 写身份由排序后的真实成员集合派生，单目录时保留原有身份，目录变化后新进程不再携带旧集合的身份。持久化 ACL 可能留下旧身份的 ACE，它们不会授权给新集合的进程；已有进程需结束后才失去旧身份。

不改写工作区或 Session 的持久化类型，不引入新的会话事件；当前成员与权限由已有的上下文快照机制记录。底座改动随 DSH 补丁提交由完整产品构建从源码编译进入载荷。
