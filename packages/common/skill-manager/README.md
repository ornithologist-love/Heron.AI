# dsh-skill-manager

`dsh-skill-manager` 是运行在 DSH 设置页中的技能管理插件，按来源分组浏览和导出只读技能，并支持对工作区技能进行目录浏览、文件编辑、启用/停用、zip 导入/导出与删除。

## 分组配置与扩展点

顶级分组支持通过插件配置 `sections` 声明，也可由宿主或其它插件在运行时通过 `ctx.skillManager.registerSection(rule)` 注册（同 `id` 覆盖配置项，按 `order` 排序）：

- `id`: 分组唯一标识
- `title`: 分组标题
- `hint` / `info`: 副标题与说明提示
- `matchPrefixes`: 认领的 `provider` 或 `preset` 前缀列表
- `order`: 排序权重（默认 `100`）

未被任何声明分组认领的插件或预设技能分别回退到「插件」和「预设」分组（均在空时自动隐藏）；「工作区」分组始终展示在底部并保留 zip 导入与编辑能力。

## 许可与致谢

本项目基于原社区插件 [AKS1st/dsh-skill-manager](https://github.com/AKS1st/dsh-skill-manager)（MIT License，基线提交 `fb452031`）收归仓内维护，原始版权声明保留于 [LICENSE](LICENSE)。
