# Heron.AI 组合构建

标准入口为仓根 `npm run build`。根 pnpm 工作区和锁文件负责还原依赖。DSH 采用固定的官方预编译产物，涉及本地补丁的包由源码构建。依赖来源见 [依赖来源与固定版本](../../Docs/guides/dependencies.md)。

本目录负责构建仓内的 MCP Manager、Skill Manager 和社区子模块 Better Sidebar，并记录源码指纹、版本与产物哈希。

构建清单与运行时清单必须一致；校验本地 workspace、版本、marker 和产物。静态链接的基础组件由 DSH 原生 Web 构建负责。最终载荷在 `dist/app/AiHost` 或标准宿主指定目录中组装并独立校验。

DSH 历史和 RC 直接在 `packages/dsh` 子模块维护。宿主与 HMR 验证见根目录 `DEVELOPMENT.md`。
