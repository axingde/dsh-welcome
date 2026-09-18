/**
 * dsh-welcome — 每个新会话自动发欢迎消息。
 *
 * 宿主侧插件：订阅全局 `session/created` 事件，向每个新建的顶层会话
 * （delegationDepth === 0，即 web UI 新建的用户会话，跳过子智能体会话）
 * 追加一个完整的合成助手轮次：
 *
 *   turn/start → step/start → assistant/message → step/end → turn/end
 *
 * 轮次编号从 `turnBoundary` 投影读到的最新轮次号 +1，step 固定为 1。
 *
 * 效果：新会话对话顶部出现一条**正常的助手气泡**「Hello,欢迎来到DSH」，
 * 由助手"直接说出"，而不是带 plugin 标签的上下文注入。因为：
 *   - UI 的助手节点由 step/start 启动、assistant/message 定稿（无 chunk 也可渲染）；
 *   - 轮次完整闭合（turn/end），对话流/轨迹/统计折叠都视为一个普通已完成轮次；
 *   - 模型历史以这条 assistant 消息开头，用户第一条消息到来时自然衔接。
 *
 * ## 格式约束（不要改回 turn:0 / step:0）
 *
 * 会话格式要求 `assistant/message` / `assistant/attempt` / `system/message` 的
 * `turn`、`step` 必须是**正整数**，且按日志顺序**严格连续**（1,2,3,…）。
 * 详见 @deepseek-ai/dsh-session-format-v2-to-v3 中的校验（"<coord> must be positive"）
 * 与迁移后的 "turn/start N does not open expected turn M" 连续性检查。
 *
 * 写入 turn:0 的后果不是当场报错，而是**这份日志永久无法迁移到 v3**：
 * v0→v1→v2 都能通过，倒在 v2→v3 这一跳，而迁移是整份日志流式进行的，
 * 一条非法事件即整个会话被拒绝，web 端表现为历史加载失败：
 *   failed to observe session "...": ... refuses this format v2 Session: turn must be positive
 *
 * 另外 `stream` 是 `assistant/message` 的**必填字段**（会话恢复时会走
 * dsh-session 的 seed 校验，要求 `data.stream` 是数组），缺了会报：
 *   stored session "..." is corrupt: seed assistant/message at index N has invalid settlement fields
 *
 * 还有一点：`turn` 不是"这条消息是第几条"，而是**日志里第几个轮次**，
 * 且必须从 `turnBoundary` 投影推导——不能写死常量，也不能假设会话是空的。
 *
 * ## 触发条件（只问候全新的空会话）
 *
 * `session/created` 不只在用户新建会话时触发：会话被迁移、恢复、重新装载时
 * 也会触发。早期版本无条件注入，导致**给历史会话补了一条问候**（污染原对话），
 * 还凭空造出一批只有问候语的空会话。因此必须同时满足：
 *   delegationDepth === 0 && !isSeeded && turnBoundary.lastTurn === 0
 *
 * 已知副作用：turn/start 会让会话立即变为非 blank（不再作为隐藏的空白占位被
 * 复用，会立刻出现在会话列表中，标题回退为 cwd 名，直到用户首条消息生成标题）。
 *
 * 持久化：`ctx.sessions.flush` 做检查点，重启后问候保留。
 */
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

/** 稳定插件名（同时也是 Loader 行 id 的默认值来源）。 */
export const name = "dsh-welcome";

/** 需要注入的服务：会话存储，以及用于读取当前轮次号的投影注册表。 */
export const inject = ["sessions", "sessionProjections"];

/** 可配置项：欢迎语文本，以及 assistant 消息的 provider/model 溯源。 */
export const Config = z.object({
  greeting: z.string().default("Hello,欢迎来到DSH"),
  provider: z.string().default("deepseek-official"),
  model: z.string().default("deepseek-v4-flash")
});

/**
 * 插件主体。
 * @param ctx - Cordis 插件上下文（提供 events / logger / sessions）。
 * @param config - 行配置（Loader schema 校验并应用默认值后传入）。
 */
export function apply(ctx, config) {
  const { greeting, provider, model } = config;
  ctx.on(
    "session/created",
    (session) => {
      // 只问候"全新的空会话"：
      //   - 子智能体会话（spawn/fork 产生，depth > 0）是内部会话；
      //   - 带种子的会话（isSeeded，例如从历史恢复、被迁移出来的会话）已经有内容，
      //     再插一条问候会污染原对话。
      if ((session.header.delegationDepth ?? 0) > 0) return;
      if (session.header.isSeeded === true) return;
      // 轮次号必须与 dsh 自身的取号一致：读 turnBoundary 投影的 lastTurn 再 +1
      // （全新会话为 1）。已有轮次的会话说明它不是空的，直接跳过。
      const lastTurn = ctx.sessionProjections.stateOf(session, "turnBoundary")?.lastTurn ?? 0;
      if (lastTurn > 0) return;
      try {
        const message = createAssistantMessage({
          content: [{ type: "text", text: greeting }],
          source: { provider, model }
        });
        const turn = lastTurn + 1;
        const step = 1;
        session.append("turn/start", { turn });
        session.append("step/start", { turn, step });
        // `stream` 是 assistant/message 的必填字段（会话恢复时会校验其为数组），
        // 合成消息没有分片流，写空数组。
        session.append("assistant/message", { turn, step, message, stream: [] }, { surfaceOp: "append" });
        session.append("step/end", { turn, step });
        session.append("turn/end", { turn, reason: { kind: "completed" } });
        // 持久化检查点：fire-and-forget。announce 已对 rejected listener 做了
        // 收容，这里再兜住 flush 本身的失败，避免未处理的 rejection。
        void ctx.sessions.flush(session).catch((error) => {
          ctx.logger.warn(`dsh-welcome: flush failed for session "${session.id}": ${String(error)}`);
        });
      } catch (error) {
        ctx.logger.warn(`dsh-welcome: greeting failed for session "${session.id}": ${String(error)}`);
      }
    },
    { global: true }
  );
}
