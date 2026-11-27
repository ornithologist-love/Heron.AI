# dsh-mcp-manager

`dsh-mcp-manager` 管理 MCP 连接和 PKCE OAuth。左侧导航的「连接器」以卡片展示插件登记的服务。

## 能力与扩展点

- **宿主运行时管理**负责配置存储、启停、断线重连和工具注册。连接器设置沿用这些连接与授权。
- **OAuth 与集成**：支持 PKCE 授权与令牌刷新；当 `useIntegration` 开启时，允许宿主或外围业务包注入拦截、可用性策略与重连协调逻辑（参见宿主侧 `mcp-oauth.mjs`）。

## 许可与致谢

本项目基于原社区插件 [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager)（MIT License，基线提交 `335f797c`）收归仓内维护，原始版权声明保留于 [LICENSE](LICENSE)。
