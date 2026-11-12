---
type: guide
covers: [packages/common/runtime/src/main.mjs, packages/common/runtime/src/heron-ai/integrations.mjs]
---

# Linux 本地运行与远程 Host

交互 DSH 的进程、工具和环境属于实际执行机器。直接在宿主机启动时，shell 工具使用该进程的 PATH、用户权限与文件系统；远程网页只是这个 Host 的另一种呈现，不改变执行位置。

运行状态与只读载荷分开。每个 Host 使用独立的 stateDir、工作区和监听端口，不能让两个进程同时写同一套会话或登记状态。进程通过标准就绪回执报告实际入口，关闭 stdin 触发原生退出及持久化。

宿主机与容器是不同执行环境。部署方按用途选择，不能把宿主已有的工具视为容器内自动可用，也不能仅凭目录能访问便判断工具执行位置。工作区选择、环境探测和诊断都应由目标 Host 返回事实。

企业服务常驻、认证和部署接线属于私有运维交付，公开客户端不附带这些配置。客户端开发命令见[开发指南](../../DEVELOPMENT.md)。

## 接入 Windows 原生侧栏

通过宿主提供的 SSH 机器配置接入同一个 Linux Host，沿用其原生工作区和会话。先核对连接返回的执行环境，避免把另一台机器的工具路径用于当前 Host。
