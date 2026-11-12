# Heron.AI 组合构建

标准入口为产品根 `npm run build`。根 pnpm 工作区和 lockfile 恢复依赖，DSH 的 Host、Client、Typert 与 Web 由子模块原生完整构建生成；产品显式固定 pnpm 工作区，避免嵌套工作区互相覆盖依赖。

本目录记录定制包的源码指纹、版本与产物哈希，只单独编译三个社区插件。社区插件使用上游 `clientBundle`，不复制产物覆盖 node_modules 中的 SDK。

构建清单与运行时清单必须一致；校验本地 workspace、版本、marker 和产物。静态链接的基础组件由 DSH 原生 Web 构建负责。最终载荷在 `dist/app/AiHost` 或标准宿主指定目录中组装并独立校验。

DSH 历史和 RC 直接在 `packages/dsh` 子模块维护。宿主与 HMR 验证见根目录 `DEVELOPMENT.md`。
