# dsh-welcome

DSH（DeepSeek Harness）插件：**每个新会话自动发一条欢迎消息**「Hello,欢迎来到DSH」，
由助手以**正常的助手气泡**直接输出（不是带 plugin 标签的上下文注入）。

## 工作原理

宿主侧插件（纯 JS，无前端构建），挂在 web profile 上：

- 订阅全局 `session/created` 事件（`ctx.on(..., { global: true })`）；
- **只问候全新的空会话**：跳过子智能体会话（`header.delegationDepth > 0`）、
  跳过带种子的会话（`header.isSeeded`）、跳过已有轮次的会话
  （`turnBoundary.lastTurn > 0`）；
- 向新会话追加一个**完整的合成助手轮次**（轮次号 = `turnBoundary` 投影的
  `lastTurn` + 1，step 从 1 开始）：

  ```
  turn/start → step/start → assistant/message → step/end → turn/end(completed)
  ```

- 调用 `ctx.sessions.flush(session)` 做持久化检查点，重启后问候保留。

为什么是合成轮次而不是注入 user 消息：

- UI 的助手节点由 `step/start` 启动、`assistant/message` 定稿——只要轮次完整闭合，
  新会话顶部就是一条正常的助手气泡「Hello,欢迎来到DSH」；
- 轮次闭合（`turn/end`）后，对话流 / 轨迹 / 会话统计（turns/steps）都把它视为一个
  普通已完成轮次，不会出现悬挂状态；
- 模型历史以这条 assistant 消息开头，用户第一条消息到来时自然衔接。

## 两个必须遵守的格式约束

> **① 轮次号不能写 0。** 会话格式要求 `assistant/message` 的 `turn`、`step` 为正整数，
> 且按日志顺序严格连续（1,2,3,…）。写 `turn:0` 不会当场报错，但会让这份日志
> **永久无法从 v2 迁移到 v3**，web 端表现为该会话历史加载失败
> （`refuses this format v2 Session: turn must be positive`）。
> 另外带种子（`parentSession` / `seedLength`）恢复的会话，日志里已有轮次，
> 所以取号必须从投影推导，不能写死常量。

> **② `stream` 是必填字段。** `assistant/message` 的 `data.stream` 必须是数组
> （合成消息没有分片流，写 `[]`）。会话恢复时会走 `dsh-session` 的 seed 校验，
> 缺字段会报 `seed assistant/message at index N has invalid settlement fields`，
> 该会话**整份无法加载**。

## 为什么不能无条件问候

`session/created` 不只在用户点"新建会话"时触发——会话被**迁移、恢复、重新装载**时
也会触发。早期版本无条件注入，后果是：

- 给历史会话中间补了一条问候，污染原对话；
- 凭空造出一批**只有问候语的空会话**（它们还会因为 `turn:0` 而加载失败）。

所以必须三条同时满足：`delegationDepth === 0 && !isSeeded && lastTurn === 0`。

已知副作用：`turn/start` 会让会话**立即变为非 blank**——新会话不再作为隐藏的空白
占位被复用，会立刻出现在会话列表中（标题回退为 cwd 名，直到用户首条消息生成标题）。

## 目录结构

```
dsh-welcome/
├── package.json      # dsh.bundle.patch 声明 → dsh plugin 会自动把它加入 bundles 层
├── index.js          # Cordis 插件本体（name / inject / Config / apply）
├── cordis.patch.yml  # bundle patch：把自己的 Loader 行插入配置树
└── test.mjs          # 逻辑单元测试（node test.mjs）
```

## 安装到 web profile

```powershell
# 需要 pnpm 在 PATH 上（npm i -g pnpm）
dsh plugin --profile web add "file:D:\dsh_stu\dsh-welcome"
```

`dsh plugin add` 会：① pnpm 安装到 profile 的 node_modules；② 检测到包声明了
`dsh.bundle.patch`，自动把它追加到 `dsh.profile.bundles` 层列表。

然后**重启 `dsh web`** 生效（web profile 的 HMR 被禁用，热更新不可用）。

> **改了源码怎么让 profile 更新？**
>
> profile 用的是 `nodeLinker: hoisted`，`node_modules/dsh-welcome` 是安装时**复制**的
> 真实目录（不是软链）；而 pnpm 在 lockfile 里对目录依赖只记 `version: file:<路径>`，
> 不含版本号。结果是**只重跑 `dsh plugin add`／`pnpm install`（含 `--force`）都是空操作**：
>
> ```
> $ dsh plugin --profile web add "file:D:\dsh_stu\dsh-welcome"
> Progress: resolved 1, reused 0, downloaded 0, added 0
> Already up to date
> ```
>
> 可靠做法是**先删掉副本再装**——pnpm 发现目录缺失才会重新打包复制：
>
> ```powershell
> Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-welcome"
> dsh plugin --profile web install
> ```
>
> 验证是否生效：比对 `node_modules\dsh-welcome\package.json` 的 `version` 与源码。
> 想免去每次重装，可改用 `link:` 协议（软链，改动即时生效），代价是插件会从自己
> 目录解析 `@deepseek-ai/*`，存在双实例风险。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里可覆盖欢迎语、provider/model
（行 id 为 `welcome`）：

```yaml
- id: welcome
  config:
    greeting: 'Hello,欢迎来到DSH'
    provider: 'deepseek-official'
    model: 'deepseek-v4-flash'
```

## 验证

- `dsh --profile web --dump-config`：查看组合后的配置树，应包含 `welcome` 行。
- `pnpm install`（或 `npm install`）后运行 `node test.mjs`：逻辑单元测试（22 项断言）。
- 端到端：`POST /api/session.create` 后读取 `session.history`，应看到
  `turn/start → step/start → assistant/message(Hello,欢迎来到DSH) → step/end → turn/end`。
- 重启后在 web UI 新建一个会话：对话顶部应出现一条**助手气泡**「Hello,欢迎来到DSH」。
  在**已有内容的历史会话**上不应出现问候（那是插件早期版本的缺陷）。

## 从 npm 安装

```powershell
dsh plugin --profile web add dsh-welcome
# 或 npx 形式
npx @deepseek-ai/dsh plugin --profile web add dsh-welcome
```

## License

MIT © [axingde](https://github.com/axingde) — 仓库：<https://github.com/axingde/dsh-welcome>
