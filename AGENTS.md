# Heron.AI 客户端源码指南

本交付包含本地运行时、通用插件、WebView Facade 和独立 App。企业后台、私有插件及其部署配置不在公开目录中；不要依赖原维护者的工作区、账号、证书或本地历史。

测试要写，重点是框架层：宿主接缝、插件清单与装配、协议和安全边界，每个用例以 `// Anchor: Docs/...` 指向成文事实；业务细节与端到端为主的用例不收，规则正文见工作区[测试规范](../Docs/TESTING.md)。上游 `packages/dsh` 沿用其自身测试规范。不扩大任务范围，不隔离编译，不覆盖用户状态。使用当前 checkout 的标准入口：

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
npm run build
npm start -- --state-dir .cache/dev-state
```

修改运行时组合后确认就绪及受影响的真实操作。产品载荷位于 dist/app，验证只使用临时状态目录。构建不能以 HMR 代替；缺少依赖必须失败，不使用旧产物顶替。

具体宿主适配器由外部贡献方通过其 SDK 构建；公共运行时不引用该适配器的源码，也不负责其产品更新或部署。

公共机制放 packages/common，宿主适配放 Facade 或宿主包，业务数据和部署凭据由外部可选插件提供。新增插件不得成为未声明的默认依赖；原有会话、配置和插件启停选择必须保留。

架构入口：[产品架构](Docs/architecture/ARCHITECTURE.md)、[宿主契约](Docs/architecture/HOST-INTEGRATION.md)、[扩展架构](Docs/architecture/extensions.md)。

公开源码使用独立的产品初始历史，子模块保留公开来源和许可证。凭据、真实会话、缓存和个人部署配置不进 Git；推送与部署仍需用户明确授权。
