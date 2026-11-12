# Heron.AI

Heron.AI 是基于 DSH 的本地 AI 产品，可独立运行，也可由其他 WebView 宿主承载。公共版提供聊天与会话、模型接入、模板机制、Skills、MCP 管理、工作区、主题和原生会话通信能力。

企业身份、团队模型、业务工具上下文、个人归档、团队会话采集和提交审查通过可选私有插件交付。普通构建不包含这些插件、部署配置或凭据。云端企业后台和服务器部署工具不属于首版公开客户端源码。

## 本地开发

环境与依赖固定版本见 [开发指南](DEVELOPMENT.md)。在当前 checkout 执行：

~~~powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
npm run build
npm start -- --state-dir .cache/dev-state
~~~

标准构建生成 dist/app/AiHost，并校验依赖、公开包体和固定 Node。运行状态、凭据和会话保存在 stateDir，验证使用临时目录。源码变化需先构建，运行时 HMR 不代替编译。

## 宿主承载

公共 Facade 管理进程、页面与通用桥接。具体宿主适配器由接入方单独交付和构建，所需 SDK 由宿主自己的标准流程提供；本仓独立 App 不依赖该适配器。

产品与宿主的启动、ready、工作区和退出协议见[宿主契约](Docs/architecture/HOST-INTEGRATION.md)。

## 插件机制

运行时插件经 DSH 原生插件管理器安装、启停。发行方也可通过外部组合清单显式预装；用户已有的数据和启停选择继续保留。机制见[扩展架构](Docs/architecture/extensions.md)。

## 许可

公共第一方代码使用 [MIT](LICENSE)；第三方组件保留原许可，见 [Third-party notices](THIRD-PARTY-NOTICES.md)。

## 架构入口

- [产品架构](Docs/architecture/ARCHITECTURE.md)与[模块地图](Docs/architecture/module-map.md)
- [模型目录与执行接入](Docs/guides/provider-catalog.md)
- [远程会话](Docs/guides/phone-remote-access.md)与[多目录工作区](Docs/guides/multi-folder-workspaces.md)
- [依赖来源](Docs/guides/dependencies.md)、[Git 工作流](Docs/guides/git-workflow.md)与[发布](Docs/guides/release.md)
