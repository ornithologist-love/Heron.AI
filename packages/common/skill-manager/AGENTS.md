# dsh-skill-manager

仓内自有源码包（`Heron.AI/packages/common/skill-manager`），不再作为 Git submodule 维护。

## 构建与校验

- 由 `Heron.AI` 根目录统一编译与打包：在 `Heron.AI` 执行 `npm run build`（经 `scripts/dsh-build/build.mjs` 使用 `tsconfig.dsh-skill-manager.{host,client}.json` 编译产出 `lib/`）。
- 禁止在本包中写死产品名称或业务专用路径（如业务技能前缀）；业务顶级分组须由宿主 `composition.mjs` 或外部插件通过 `sections` 配置 / `ctx.skillManager.registerSection()` 传入。

## 源码与文件约定

- `src/client/` 下所有源码与 CSS Module 文件统一使用 `kebab-case` 命名（如 `skill-manager-panel.tsx`、`skill-manager-editor.tsx`）。
- 保留根目录 [LICENSE](LICENSE) 中的原始 MIT 版权声明，不删改。
- 未声明的运行目录写入（写文件、删除、启停）不得放开只读来源目录白名单，保持既有路径边界检查。
