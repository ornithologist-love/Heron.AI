# dsh-mcp-manager

`dsh-mcp-manager` 是运行在 DSH 设置页中的 MCP 服务器管理插件，负责全局/项目级 MCP 服务器的增删改查、启停、断线重连以及 PKCE OAuth 登录流程。

## 能力与扩展点

- **宿主运行时管理**：管理 MCP 服务器配置存储与生命周期连接，向 Web 设置页提供 `list` / `add` / `update` / `setEnabled` / `remove` / `reconnect` 等通道。
- **OAuth 与集成**：支持 PKCE 授权与令牌刷新；当 `useIntegration` 开启时，允许宿主或外围业务包注入拦截、可用性策略与重连协调逻辑（参见宿主侧 `mcp-oauth.mjs`）。

## 许可与致谢

本项目基于原社区插件 [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager)（MIT License，基线提交 `335f797c`）收归仓内维护，原始版权声明保留于 [LICENSE](LICENSE)。
