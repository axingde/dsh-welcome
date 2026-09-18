# dsh-welcome

[![npm version](https://img.shields.io/npm/v/dsh-welcome)](https://www.npmjs.com/package/dsh-welcome)
[![license](https://img.shields.io/npm/l/dsh-welcome)](./LICENSE)

DSH（DeepSeek Harness）插件：**每个新建的空会话自动发一条欢迎消息**「Hello,欢迎来到DSH」，
由助手以**正常的助手气泡**直接输出（不是带 plugin 标签的上下文注入）。

## 快速开始

> 面向普通用户，三步完成。开发者请看[本地开发](#本地开发)。

### 1. 安装

```powershell
dsh plugin --profile web add dsh-welcome
# 指定版本
dsh plugin --profile web add dsh-welcome@0.1.3
# 或 npx 形式
npx @deepseek-ai/dsh plugin --profile web add dsh-welcome
```

### 2. 配置（可选）

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里可覆盖欢迎语、provider/model
（行 id 为 `welcome`）：

```yaml
- id: welcome
  config:
    greeting: 'Hello,欢迎来到DSH'
    provider: 'deepseek-official'
    model: 'deepseek-v4-flash'
```

### 3. 验证

重启 `dsh web`（web profile 的 HMR 被禁用，新装/更新的插件必须重启才生效）：

```powershell
# 停掉正在运行的 dsh web（Ctrl+C），再重新启动
dsh web
# 未全局安装 dsh 时，用 npx 形式
npx @deepseek-ai/dsh web
```

然后在 web UI 新建一个会话：

- 对话顶部出现一条**助手气泡**「Hello,欢迎来到DSH」→ 安装成功；
- **已有内容的历史会话**不应出现问候（出现则是早期版本的缺陷）。

## 目录结构

```
dsh-welcome/
├── package.json      # dsh.bundle.patch 声明 → dsh plugin 会自动把它加入 bundles 层
├── index.js          # Cordis 插件本体（name / inject / Config / apply）
├── cordis.patch.yml  # bundle patch：把自己的 Loader 行插入配置树
└── test.mjs          # 逻辑单元测试（node test.mjs）
```

## 工作原理

宿主侧插件（纯 JS，无前端构建），挂在 web profile 上：

- 订阅全局 `session/created` 事件（`ctx.on(..., { global: true })`）；
- 依赖 `inject: ["sessions", "sessionProjections"]`，后者用于读取当前轮次号；
- **只问候全新的空会话**，三个条件缺一不可：
  `delegationDepth === 0 && !isSeeded && lastTurn === 0`；
- 向新会话追加一个**完整的合成助手轮次**（轮次号 = `lastTurn + 1`，step 从 1 开始）：

  ```
  turn/start → step/start → assistant/message → step/end → turn/end(completed)
  ```

- 调用 `ctx.sessions.flush(session)` 做持久化检查点，重启后问候保留。

**为什么是合成轮次而不是注入 user 消息**：轮次完整闭合后，UI 呈现为一条正常的
助手气泡；对话流 / 轨迹 / 会话统计都视其为普通已完成轮次；模型历史以这条
assistant 消息开头，用户第一条消息自然衔接。

**为什么不能无条件问候**：`session/created` 在会话**迁移、恢复、重新装载**时也会
触发。早期版本无条件注入，导致给历史会话中间补问候、凭空造出只有问候语的空会话
（且因 `turn:0` 无法加载）。

**已知副作用**：`turn/start` 会让新会话立即变为非 blank——不再作为隐藏占位被
复用，会立刻出现在会话列表中（标题回退为 cwd 名，直到首条消息生成标题）。

## 格式约束

> **① 轮次号不能写 0。** `assistant/message` 的 `turn`、`step` 须为正整数且严格
> 连续。写 `turn:0` 不会当场报错，但日志**永久无法从 v2 迁移到 v3**，web 端报
> `refuses this format v2 Session: turn must be positive`。取号必须从投影推导，
> 不能写死常量。

> **② `stream` 是必填字段。** `data.stream` 必须是数组（合成消息写 `[]`）。缺失会
> 在会话恢复时报 `seed assistant/message at index N has invalid settlement fields`，
> 该会话**整份无法加载**。

## 本地开发

### 从本地源码安装

面向两种情况：① 开发者本地改源码调试；② npm 版本不满足需求，从 GitHub 下载源码安装。

```powershell
# 需要 pnpm 在 PATH 上（npm i -g pnpm）
dsh plugin --profile web add "file:D:\path\to\dsh-welcome"
```

`dsh plugin add` 会：① pnpm 安装到 profile 的 node_modules；② 检测到包声明了
`dsh.bundle.patch`，自动把它追加到 `dsh.profile.bundles` 层列表。

### 改了源码怎么让 profile 更新

profile 用 `nodeLinker: hoisted`，`node_modules/dsh-welcome` 是安装时**复制**的
真实目录（不是软链）；而 pnpm 对 `file:` 目录依赖在 lockfile 里只记
`version: file:<路径>`，不含版本号——重跑 `add` / `install`（含 `--force`）都是
空操作（`Already up to date`）。

可靠做法是**先 `remove` 再 `add`**（`dsh plugin` 是 pnpm 的薄转发器，`remove`
会把副本、依赖声明、bundles 条目一并清掉）：

```powershell
dsh plugin --profile web remove dsh-welcome
dsh plugin --profile web add "file:D:\path\to\dsh-welcome"
```

注意：

- `update` 解决不了这个问题——它只对 registry 包有效，对 `file:` 依赖同样是空操作；
- 手动等价写法是 `Remove-Item` 删掉 `node_modules\dsh-welcome` 后 `install`，
  但不会清理依赖声明与 bundles 条目；
- 想免去每次重装可改用 `link:` 协议（软链，改动即时生效），代价是插件会从自己
  目录解析 `@deepseek-ai/*`，存在双实例风险；
- 验证是否生效：比对 `node_modules\dsh-welcome\package.json` 的 `version` 与源码。

### 开发者验证

- `dsh --profile web --dump-config`：组合后的配置树应包含 `welcome` 行；
- `pnpm install` 后运行 `node test.mjs`：逻辑单元测试（22 项断言）；
- 端到端：`POST /api/session.create` 后读取 `session.history`，应看到
  `turn/start → step/start → assistant/message(Hello,欢迎来到DSH) → step/end → turn/end`。

## 更新记录

### 0.1.3

修复两个都会导致**会话整份无法加载**的缺陷，并收紧触发条件：

- 轮次坐标不再写死 `turn:0 / step:0`，改为从 `turnBoundary` 投影取
  `lastTurn + 1`、step 从 1 开始（`turn:0` 会让日志**永久无法迁移到 v3**）；
- `assistant/message` 补上必填字段 `stream: []`；
- 触发条件收紧为 `delegationDepth === 0 && !isSeeded && lastTurn === 0`
  （0.1.2 会给历史会话补问候、并造出空会话）；
- `inject` 增加 `sessionProjections`（用于读取当前轮次号）。

> 从 0.1.2 升级：需**先 remove 再 add** 才会真正更新：
>
> ```powershell
> dsh plugin --profile web remove dsh-welcome
> dsh plugin --profile web add dsh-welcome@0.1.3
> ```
>
> 原因见「改了源码怎么让 profile 更新」。

### 0.1.2

- 欢迎语改为「Hello,欢迎来到DSH」。

### 0.1.1

- 首个版本：向新会话注入一个完整的合成助手轮次。

## License

MIT © [axingde](https://github.com/axingde) — 仓库：<https://github.com/axingde/dsh-welcome>
