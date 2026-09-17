# useful-dsh-plugins

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合，采用 Bun workspace
组织，每个插件是独立发布的包。

## 插件列表

| 插件                                                   | 作用                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@reedchan7/dsh-cost`](plugins/dsh-cost/README_CN.md) | 在 DSH composer 统计行显示本会话、本轮与今日（全部项目）的 API 费用估算，并可按模型展开明细；语言跟随 DSH 设置，时间按读取者所在时区呈现。 |

## 快速开始

```sh
git clone https://github.com/reedchan7/useful-dsh-plugins
cd useful-dsh-plugins
make setup          # bun install 并安装 lefthook git hooks（需要先有 git 仓库）
make check          # 格式、Lint、类型、文档配对、测试、构建
```

把插件装进你的 DSH profile：

```sh
make install                                             # 把本仓库以 link 方式装进 `web` profile
make install PLUGIN='github:reedchan7/useful-dsh-plugins#v0.1.0'   # 或指定 git tag
make uninstall                                           # 卸载
```

随后重启 `dsh web`，并在浏览器里强制刷新。

## 仓库组织方式

```
plugins/*     一个目录一个插件；各自带 DSH bundle，可选带浏览器半边
lib/          共享 TypeScript 库，构建期内联进插件（运行时不是依赖）
scripts/      构建编排
templates/    `make new NAME=...` 复制的骨架
tools/        仓库工具（文档配对、提交信息、脚手架）
```

这套结构由两条已对 DSH 0.1.5 与 Bun 1.4 实测确认的约束决定：

- **插件包运行时零依赖**。DSH 用 `dsh plugin` 把插件装进 profile，它底层转发给 pnpm；pnpm 与 bun 都不会
  安装 link 包的传递依赖，所以插件运行时 import 的任何东西都必须由 `scripts/build-plugins.ts` 内联进它自己的
  `lib/`。这正是 `lib/*` 只共享源码的原因。
- **浏览器半边是 `window.__ModuleLoader__.load(...)` 包装的包**，不是 ES module。DSH 的客户端模块表拉取
  `lib/client.js`，把绑定到平台模块表（react、react-dom、`@deepseek-ai/dsh-client-*`）的 `require` 交给
  factory，并要求返回 `apply`/`inject`。`bun build` 配合 banner 与 footer 正好产出这种形态；
  `plugins/dsh-cost/tests/client-bundle.test.ts` 断言该契约，避免构建回归流到浏览器。

新插件必须遵守的约定见 [AGENTS.md](AGENTS.md)，第一个插件的实现细节见
[plugins/dsh-cost/README_CN.md](plugins/dsh-cost/README_CN.md)。

## 开发命令

已在 Makefile 里分组，`make help` 会按同样的分组打印。

| 命令                        | 用途                                                 |
| --------------------------- | ---------------------------------------------------- |
| `make env` / `make doctor`  | 打印解析后的工具链，并在安装前检查 profile           |
| `make check`                | 运行全部质量门（格式、Lint、类型、文档、测试、构建） |
| `make test`                 | 运行测试（Bun 测试运行器）                           |
| `make build`                | 构建全部插件到 `plugins/<name>/lib`                  |
| `make pack`                 | 为每个插件产出可安装 tarball                         |
| `make publish`              | 发布插件到 npmjs.com（需先 `npm login`）             |
| `make verify SESSION=<id>`  | 向运行中的宿主查询某个会话的费用汇总                 |
| `make new NAME=dsh-example` | 生成新插件骨架                                       |

Git hooks（lefthook）在提交时格式化并 Lint 暂存文件、在 README 单侧改动时检查配对，在推送时跑类型检查与受影响
的测试。`make hooks` 会把它们装进 git 仓库；全新检出时请先 `git init`。

## 文档语言

代码、注释、提交信息与英文文档一律使用英文。每个 `README.md` 都有对应的 `README_CN.md`；缺失或结构漂移时
`make docs-check` 会失败。

## 许可证

[MIT](LICENSE)
