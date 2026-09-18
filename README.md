# dsh-welcome

DSH（DeepSeek Harness）插件：**每个新会话自动发一条欢迎消息**「你好，欢迎来到harness」，
由助手以**正常的助手气泡**直接输出（不是带 plugin 标签的上下文注入）。

## 工作原理

宿主侧插件（纯 JS，无前端构建），挂在 web profile 上：

- 订阅全局 `session/created` 事件（`ctx.on(..., { global: true })`）；
- 跳过子智能体会话（`header.delegationDepth > 0`）；
- 向新会话追加一个**完整的合成助手轮次**（turn 0 / step 0）：

  ```
  turn/start → step/start → assistant/message → step/end → turn/end(completed)
  ```

- 调用 `ctx.sessions.flush(session)` 做持久化检查点，重启后问候保留。

为什么是合成轮次而不是注入 user 消息：

- UI 的助手节点由 `step/start` 启动、`assistant/message` 定稿——只要轮次完整闭合，
  新会话顶部就是一条正常的助手气泡「你好，欢迎来到harness」；
- 轮次闭合（`turn/end`）后，对话流 / 轨迹 / 会话统计（turns/steps）都把它视为一个
  普通已完成轮次，不会出现悬挂状态；
- 模型历史以这条 assistant 消息开头，用户第一条消息到来时自然衔接（从 turn 1 继续）。

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

> 注意：`file:` 依赖是安装时的快照拷贝。修改源码后需要**升版本号**（package.json
> 的 `version`）再重跑上面的 add 命令，或手动把文件复制到
> `$DSH_HOME\profiles\web\node_modules\dsh-welcome\`。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里可覆盖欢迎语、provider/model
（行 id 为 `welcome`）：

```yaml
- id: welcome
  config:
    greeting: '你好，欢迎来到harness'
    provider: 'deepseek-official'
    model: 'deepseek-v4-flash'
```

## 验证

- `dsh --profile web --dump-config`：查看组合后的配置树，应包含 `welcome` 行。
- `node test.mjs`：逻辑单元测试（17 项断言）。
- 端到端：`POST /api/session.create` 后读取 `session.history`，应看到
  `turn/start → step/start → assistant/message(你好，欢迎来到harness) → step/end → turn/end`。
- 重启后在 web UI 新建一个会话：对话顶部应出现一条**助手气泡**「你好，欢迎来到harness」。

## 从 npm 安装

```powershell
dsh plugin --profile web add dsh-welcome
# 或 npx 形式
npx @deepseek-ai/dsh plugin --profile web add dsh-welcome
```

## License

MIT © [axingde](https://github.com/axingde) — 仓库：<https://github.com/axingde/dsh-welcome>
