# dsh-mcp-manager

仓内自有源码包（`Heron.AI/packages/common/mcp-manager`），不再作为 Git submodule 维护。

## 构建与校验

- 由 `Heron.AI` 根目录统一编译与打包：在 `Heron.AI` 执行 `npm run build`（经 `scripts/dsh-build/build.mjs` 使用 `tsconfig.dsh-mcp-manager.{host,client}.json` 与 `scripts/build.mjs` 产出 `lib/`）。
- 禁止在本包中硬编码产品名称或具体业务端点；保留端点可见性控制与 OAuth 接入由宿主通过配置和集成策略注入（参见 `Heron.AI/Docs/architecture/DEVELOPMENT-GOTCHAS.md` K-025）。

## 源码与文件约定

- `src/client/` 下新建或重命名的源码与样式文件统一使用 `kebab-case` 命名（如 `mcp-manager-section.module.css`）。
- 保留根目录 [LICENSE](LICENSE) 中的原始 MIT 版权声明，不删改。
- 未经校验不得在 `transformEntry` 异常路径之外绕过 `isAvailable` 检查，避免连接状态卡在“连接中”。
