/**
 * dsh-welcome — 每个新会话自动发欢迎消息。
 *
 * 宿主侧插件：订阅全局 `session/created` 事件，向每个新建的顶层会话
 * （delegationDepth === 0，即 web UI 新建的用户会话，跳过子智能体会话）
 * 追加一个完整的合成助手轮次（turn 0 / step 0）：
 *
 *   turn/start → step/start → assistant/message → step/end → turn/end
 *
 * 效果：新会话对话顶部出现一条**正常的助手气泡**「你好，欢迎来到harness」，
 * 由助手"直接说出"，而不是带 plugin 标签的上下文注入。因为：
 *   - UI 的助手节点由 step/start 启动、assistant/message 定稿（无 chunk 也可渲染）；
 *   - 轮次完整闭合（turn/end），对话流/轨迹/统计折叠都视为一个普通已完成轮次；
 *   - 模型历史以这条 assistant 消息开头，用户第一条消息到来时自然衔接（turn 1）。
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

/** 需要注入的服务：会话存储。 */
export const inject = ["sessions"];

/** 可配置项：欢迎语文本，以及 assistant 消息的 provider/model 溯源。 */
export const Config = z.object({
  greeting: z.string().default("你好，欢迎来到harness"),
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
      // 只问候顶层用户会话；子智能体会话（spawn/fork 产生，depth > 0）是内部会话。
      if ((session.header.delegationDepth ?? 0) > 0) return;
      try {
        const message = createAssistantMessage({
          content: [{ type: "text", text: greeting }],
          source: { provider, model }
        });
        const turn = 0;
        const step = 0;
        session.append("turn/start", { turn });
        session.append("step/start", { turn, step });
        session.append("assistant/message", { turn, step, message }, { surfaceOp: "append" });
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
