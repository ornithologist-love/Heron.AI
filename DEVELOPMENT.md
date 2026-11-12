# Heron.AI 本地开发

环境与固定依赖由本仓维护。DSH、MCP 管理器、技能管理器与 BSB 是四个独立子模块，来源和许可证见[依赖来源](Docs/guides/dependencies.md)。

## 拉取与启动

使用 Git、Node 24+、pnpm 11.28.5 与 .NET SDK。发布 Node 由 node-runtime.json 固定。

~~~powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
npm run build
npm start -- --state-dir .cache/dev-state
~~~

标准构建生成 dist/app/AiHost，使用固定官方 DSH 产物并构建声明的通用补口、社区和产品组件。首次可提前运行 npm run dsh:prepare 准备依赖。独立桌面壳使用 npm run build:app；C# Facade 与 App 保持在 Facade 目录。

普通构建是 Public 组合。业务内容、宿主适配、远程服务和更新策略由外部包提供；发行方通过显式组合清单预装，或由用户使用原生插件管理器安装。公共构建不查找原维护者的工作区。

认证 URL、凭据、状态和验证数据不提交。调试使用临时 stateDir，应用载荷与用户数据分开。具体宿主的 SDK、C# 插件包装和部署由接入方的标准入口负责。

## 手机预览

运行 npm run dev:mobile，构建后启动本地 sidecar 并打开手机视口。它预览公共响应式页面，不模拟手机操作系统、远程登录或软键盘。视口切换保留页面状态，停止终端结束该预览。

## 宿主与前端热更新

Debug 宿主和 npm run dev 启用后端文件监听与前端插件 HMR；发布构建默认关闭，显式本地插件开发选择可以启用。HMR 消费实际运行目录中的 JS 产物，不代替 TS、Vue、C# 编译，也不从业务源码目录自动装配未声明的包。启动依赖无法安全替换时，重载结果明确要求重启。

common UI 的 Vite 开发入口使用 HERON_AI_UI_DEV_SERVER 指定 loopback HTTP，仅在 Debug 宿主注入。进程、页面及就绪协议见[宿主契约](Docs/architecture/HOST-INTEGRATION.md#h61-开发入口)。

## 修改与提交

公共机制放 packages/common，具体业务和产品策略由可选包维护。底座缺少能力时按[业务定制边界](Docs/architecture/dsh-customization.md)补通用接口；不把业务回流到底座。固定版本只认父仓的 gitlink，恢复时使用 git submodule update --init --recursive。

不新增或执行测试，使用本仓标准构建及受影响的实际入口验证。未经授权不推送、不远程部署；Git 与依赖维护规则见[Git 工作流](Docs/guides/git-workflow.md)。
