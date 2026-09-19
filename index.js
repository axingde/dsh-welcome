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
 * `turn`、`step` 必须是**正整数**。校验在
 * `@deepseek-ai/dsh-session-format-v2-to-v3` 里（"<coord> must be positive"）：
 *
 *   if (event.type === "assistant/message" || event.type === "assistant/attempt")
 *     for (const coordinate of ["turn", "step"])
 *       if (sessionFormatCount(data[coordinate], coordinate) === 0) throw ...
 *
 * 所以欢迎语**必须**寄生在某个轮次里，写不成没有坐标的游离消息。
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
 * ## 轮次号归谁：宿主是唯一分配者，本插件只准"抢跑"不准"插队"
 *
 * `turn` 不是"这条消息是第几条"，而是**日志里第几个轮次**，且按日志顺序严格连续。
 * 分配者是 `@deepseek-ai/dsh-agent-loop`，它的取号逻辑是**构造期快照 + 内存递增**：
 *
 *   constructor(...) {
 *     const lastTurn = ctx.sessionProjections.stateOf(session, "turnBoundary")?.lastTurn ?? 0;
 *     this.phase = { kind: "idle", lastTurn };   // ← 只在这里读一次投影
 *   }
 *   async turn() {
 *     const turn = this.phase.turn + 1;          // ← 之后只加内存计数
 *     this.session.append("turn/start", { turn });
 *   }
 *
 * 所以本插件在 `session/created` 里自开一个轮次时，只有两种结局：
 *
 *   (a) 宿主还没为这个会话建 agent loop —— 它稍后构造，会从 seq 0 回放日志
 *       （投影 cell 懒构建，缺行时 `need = 0`），读到 welcome 的 turn 1，
 *       于是它首轮取到 turn 2。**安全**，气泡在空会话里立刻可见。
 *
 *   (b) 宿主已经建好 agent loop —— 它的 `phase.lastTurn` 已在构造期定格为 0，
 *       不会重读投影。用户随后提问时它取 `0 + 1 = 1`，**和欢迎语撞号**。
 *       日志出现 `1,1,2,3,…`，按轮次归组的视图把第一次问答压在问候语下，
 *       表现为"欢迎语还在、那条记录没了"。
 *
 * 实测：`session-10de4e2b` 序列 `1,1,2,…,7`（冲突 @09:18:12）、
 * `session-8e2fea4d` 序列 `1,1,2`（冲突 @09:44:59）；而插件之后的老会话
 * `760d04fe` / `c9ee95f4` / `3fc3afb1` 序列都是干净的 1..N。
 *
 * 因此本插件采取**三级策略**，任何情况下都不会写出重复轮次号：
 *
 *   1. 宿主还没接管（`ctx.agents.get(id) === undefined`）→ 自开轮次 (a)，
 *      宿主稍后回放日志自然接上，气泡立刻可见。
 *   2. 宿主已接管、且它的 `phase` 是已知形态、空闲、快照与投影一致 → 仍然自开
 *      轮次，但**把宿主的取号计数拨到我们之后**（`phase.lastTurn = turn`，优先走
 *      宿主自己的 `setPhase`），宿主下个轮次取 2。这是保住"空会话即见问候"的唯一
 *      办法：宿主的计数是不可观测的构造期快照，只能由我们补齐。不做这一步就是 (b)
 *      的撞号。
 *   3. 宿主已接管、但上面任一项不成立 → **绝不自开轮次**，改为挂
 *      `session/event` 等宿主自己开首轮，再把欢迎语插进它那个 step。轮次号完全
 *      属于宿主，逻辑上不可能撞号；代价是气泡随用户第一条消息一起出现。
 *
 * 宿主请求由 `session.deriveMessages()` 组装（agent-loop 里
 * `const boundaryMessages = session.deriveMessages()`），所以路径 3 插入的额外
 * surface 节点会自动进入该轮次请求，不会与请求重建不变式冲突。
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
 * 路径 3 不写 turn/start，因此不会触发这个副作用。
 *
 * 持久化：`ctx.sessions.flush` 做检查点，重启后问候保留。
 */
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

/** 稳定插件名（同时也是 Loader 行 id 的默认值来源）。 */
export const name = "dsh-welcome";

/** 需要注入的服务：会话存储、读取轮次号的投影注册表、以及宿主 agent 注册表。 */
export const inject = ["sessions", "sessionProjections", "agents"];

/** 可配置项：欢迎语文本，以及 assistant 消息的 provider/model 溯源。 */
export const Config = z.object({
  greeting: z.string().default("Hello,欢迎来到DSH"),
  provider: z.string().default("deepseek-official"),
  model: z.string().default("deepseek-v4-flash")
});

/**
 * 插件主体。
 * @param ctx - Cordis 插件上下文（提供 events / logger / sessions / agents）。
 * @param config - 行配置（Loader schema 校验并应用默认值后传入）。
 */
export function apply(ctx, config) {
  const { greeting, provider, model } = config;

  /**
   * 走路径 3、欠着一条欢迎语的会话：等宿主自己开首轮时再补。
   * 只活在内存里；会话重载后 `session/created` 的三重守卫会挡住它们，
   * 不会补第二次。
   */
  const awaitingFirstStep = new WeakSet();

  /** 造一条合成助手消息（欢迎语本体）。 */
  const greetingMessage = () =>
    createAssistantMessage({
      content: [{ type: "text", text: greeting }],
      source: { provider, model }
    });

  /** 持久化检查点：fire-and-forget，兜住 flush 自身的失败。 */
  const flush = (session) => {
    void ctx.sessions.flush(session).catch((error) => {
      ctx.logger.warn(`dsh-welcome: flush failed for session "${session.id}": ${String(error)}`);
    });
  };

  /**
   * 把宿主 agent loop 的取号计数拨到 `turn` 之后。
   *
   * 宿主只在构造时读一次 `turnBoundary`，之后一律 `phase.turn + 1`，
   * 所以"宿主已接管"时这一步是必需的：不做的话宿主会把 `turn` 再分配一次。
   *
   * 只在这三项全都成立时才动手，任何不符合预期的形态都返回 "unknown"，
   * 由调用方退到路径 3——**绝不硬写**：
   *   - `phase.kind === "idle"`：这正是宿主自己空闲时持有的形态
   *     `{ kind: "idle", lastTurn }`；正在运行时它有 abort/turn/step，不能碰；
   *   - `lastTurn` 是数字；
   *   - `lastTurn === expectedTurn`：宿主快照与投影必须一致（两者读的是同一个
   *     `turnBoundary.lastTurn`）。不一致说明会话处于我们无法建模的状态，
   *     此时强行占号会让日志出现空洞（1 之后直接跳到 4）。
   *
   * @param session - 目标会话。
   * @param turn - 我们已经占用的轮次号。
   * @param expectedTurn - 投影给出的、我们占号前应有的轮次号。
   * @returns "absent"（宿主尚未接管）| "synced"（已拨正）| "unknown"（形态不认识）。
   */
  const syncAgentTurn = (session, turn, expectedTurn) => {
    const agent = ctx.agents.get(session.id);
    if (agent === undefined) return "absent";
    const { phase } = agent;
    if (phase?.kind !== "idle" || typeof phase.lastTurn !== "number") return "unknown";
    if (phase.lastTurn !== expectedTurn) return "unknown";
    const next = { ...phase, lastTurn: turn };
    // 优先走宿主自己的 setPhase（状态未变，不会多发 agent/status）。
    if (typeof agent.setPhase === "function") agent.setPhase(next);
    else agent.phase = next;
    return "synced";
  };

  /**
   * 路径 1/2：自开一个完整的合成助手轮次（气泡立刻可见）。
   * @param session - 目标会话。
   * @param turn - 已经确认安全的轮次号。
   */
  const greetWithOwnTurn = (session, turn) => {
    session.append("turn/start", { turn });
    session.append("step/start", { turn, step: 1 });
    // `stream` 是 assistant/message 的必填字段（会话恢复时会校验其为数组），
    // 合成消息没有分片流，写空数组。
    session.append(
      "assistant/message",
      { turn, step: 1, message: greetingMessage(), stream: [] },
      { surfaceOp: "append" }
    );
    session.append("step/end", { turn, step: 1 });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  };

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
      const turn = lastTurn + 1;
      try {
        if (syncAgentTurn(session, turn, lastTurn) === "unknown") {
          // 路径 3：宿主已接管但轮次状态不是我们认识的形态。自开轮次会撞号，
          // 于是把问候语寄存起来，等宿主自己开首轮时插进它那个 step。
          awaitingFirstStep.add(session);
          ctx.logger.warn(
            `dsh-welcome: session "${session.id}" is already held by an agent whose turn cursor is ` +
              `unrecognized; greeting deferred until the host opens its first step`,
          );
          return;
        }
        greetWithOwnTurn(session, turn);
        flush(session);
      } catch (error) {
        ctx.logger.warn(`dsh-welcome: greeting failed for session "${session.id}": ${String(error)}`);
      }
    },
    { global: true }
  );

  // 路径 3 的落地点：宿主每追加一个事件都会走 `session/event` 消防水管。
  // 只等它开第一个 step，然后**在通知里同步**把欢迎语追加到同一个 (turn, step)
  // ——此刻 step 已开，坐标合法；且排在宿主的 system/user 消息之前，
  // 视觉上仍在对话顶部。
  ctx.on(
    "session/event",
    (session, event) => {
      if (!awaitingFirstStep.has(session)) return;
      if (event.type !== "step/start") return;
      const { turn, step } = event.data ?? {};
      if (!Number.isInteger(turn) || !Number.isInteger(step) || turn < 1 || step < 1) return;
      awaitingFirstStep.delete(session);
      try {
        session.append(
          "assistant/message",
          { turn, step, message: greetingMessage(), stream: [] },
          { surfaceOp: "append" }
        );
        flush(session);
      } catch (error) {
        ctx.logger.warn(
          `dsh-welcome: deferred greeting failed for session "${session.id}": ${String(error)}`
        );
      }
    },
    { global: true }
  );
}
