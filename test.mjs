/**
 * dsh-welcome 逻辑单元测试：不依赖完整 harness，直接用 mock ctx/session
 * 验证 Config 默认值与 apply() 的三条问候路径。
 *
 * 覆盖：
 *   - 路径 1：宿主尚未接管 → 自开轮次，气泡立刻可见
 *   - 路径 2：宿主已接管且空闲 → 自开轮次 + 拨正宿主取号计数（防撞号）
 *   - 路径 3：宿主已接管但取号状态不可预期 → 绝不自开轮次，寄生到宿主首轮 step
 *   - 守卫：已有轮次 / 带种子 / 子智能体会话都不问候
 *
 * 运行：node test.mjs
 */
import { apply, Config } from "./index.js";

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
}

const GREETING = "Hello,欢迎来到DSH";

/** mock 一个 Cordis ctx；agent 传 undefined 表示宿主尚未为该会话建 loop。 */
function makeCtx({ lastTurn = 0, agent } = {}) {
  const listeners = new Map();
  const warnings = [];
  return {
    listeners,
    warnings,
    on(event, cb, opts) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ cb, opts });
    },
    logger: {
      warn: (...args) => warnings.push(args.join(" ")),
      info: (...args) => warnings.push(args.join(" "))
    },
    sessions: {
      async flush() {
        return true;
      }
    },
    sessionProjections: {
      stateOf(_session, key) {
        return key === "turnBoundary" ? { lastTurn } : undefined;
      }
    },
    agents: {
      get: () => agent
    }
  };
}

/** 触发所有监听某个事件的回调（模拟宿主的事件广播）。 */
function emit(ctx, event, ...args) {
  for (const { cb } of ctx.listeners.get(event) ?? []) cb(...args);
}

/**
 * mock session：`append` 会像真实宿主一样把事件回灌到 `session/event`
 * 消防水管，这样才能验证"宿主开 step → 插件补问候"以及不会重复注入。
 */
function makeSession(ctx, id, delegationDepth, headerExtra = {}) {
  const appended = [];
  const session = {
    id,
    appended,
    header: { id, delegationDepth, isSeeded: false, ...headerExtra },
    append(type, data, opts) {
      appended.push({ type, data, opts });
      emit(ctx, "session/event", session, { type, data, seq: appended.length - 1 });
    }
  };
  return session;
}

/** 模拟"宿主自己"追加一个事件（走同一 append 通道）。 */
function hostAppend(ctx, session, type, data) {
  session.append(type, data);
}

const DEFAULT_CONFIG = {
  greeting: GREETING,
  provider: "deepseek-official",
  model: "deepseek-v4-flash"
};

// ── Config schema 默认值 ───────────────────────────────────────────────
{
  console.log("Config schema 默认值:");
  const resolved = Config({});
  assert(resolved.greeting === GREETING, `默认欢迎语为 "${GREETING}"（实际: ${resolved.greeting}）`);
  assert(
    resolved.provider === "deepseek-official" && resolved.model === "deepseek-v4-flash",
    "默认 provider/model 正确"
  );
}

// ── 路径 1：宿主尚未接管 → 自开完整合成轮次 ──────────────────────────────
{
  console.log("路径 1：宿主尚未接管 (ctx.agents.get() === undefined):");
  const ctx = makeCtx();
  apply(ctx, DEFAULT_CONFIG);
  assert(ctx.listeners.has("session/created"), "注册了 session/created 监听");
  assert(ctx.listeners.get("session/created")[0].opts?.global === true, "session/created 是全局监听");
  assert(ctx.listeners.has("session/event"), "注册了 session/event 监听（路径 3 用）");
  assert(ctx.listeners.get("session/event")[0].opts?.global === true, "session/event 是全局监听");

  const session = makeSession(ctx, "sess-1", 0);
  emit(ctx, "session/created", session);

  assert(session.appended.length === 5, "恰好追加 5 个事件（完整轮次）");
  const types = session.appended.map((e) => e.type);
  assert(
    JSON.stringify(types) === JSON.stringify([
      "turn/start",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end"
    ]),
    `事件顺序正确: ${types.join(" → ")}`
  );
  // 轮次号必须是正整数：dsh 会话格式要求 assistant/message 的 turn/step >= 1。
  assert(session.appended[0].data.turn === 1, `全新会话轮次号为 1（实际: ${session.appended[0].data.turn}）`);
  assert(session.appended[1].data.turn === 1 && session.appended[1].data.step === 1, "step 从 1 开始");
  const msgEvent = session.appended[2];
  assert(msgEvent.opts?.surfaceOp === "append", "assistant/message 带 surfaceOp append");
  // stream 是 assistant/message 的必填字段（恢复时校验为数组），合成消息写空数组。
  assert(
    Array.isArray(msgEvent.data.stream) && msgEvent.data.stream.length === 0,
    `assistant/message 的 data.stream 是空数组（实际: ${JSON.stringify(msgEvent.data.stream)}）`
  );
  const msg = msgEvent.data.message;
  assert(msg.role === "assistant", "消息 role 为 assistant");
  assert(typeof msg.id === "string" && msg.id !== "", "消息带稳定 id");
  assert(msg.source?.kind === "model", "消息 source 为 model");
  assert(
    msg.source?.provider === "deepseek-official" && msg.source?.model === "deepseek-v4-flash",
    "带 provider/model 溯源"
  );
  assert(msg.content?.[0]?.type === "text" && msg.content[0].text === GREETING, "内容为问候文本");
  assert(session.appended[3].data.step === 1, "step/end 关闭 step 1");
  assert(session.appended[4].data.reason?.kind === "completed", "turn/end 以 completed 关闭");
  assert(ctx.warnings.length === 0, "没有告警");
}

// ── 路径 2：宿主已接管且空闲 → 自开轮次 + 拨正宿主取号 ────────────────────
// 真因 A 的修复核心：宿主只在构造期读一次 turnBoundary，之后只加内存计数，
// 所以必须把它的 lastTurn 拨到我们占用的轮次之后，否则它会重复分配 turn 1。
{
  console.log("路径 2：宿主已接管且空闲 (agent.phase = {kind:'idle', lastTurn:0}):");
  const agent = { phase: { kind: "idle", lastTurn: 0 } };
  const ctx = makeCtx({ agent });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-2", 0);
  emit(ctx, "session/created", session);

  assert(session.appended.length === 5, "仍然自开完整轮次（气泡立刻可见）");
  assert(session.appended[0].data.turn === 1, "占用的轮次号为 1");
  assert(agent.phase.lastTurn === 1, `宿主取号已拨到 1，其下一轮将取 2（实际: ${agent.phase.lastTurn}）`);
  assert(agent.phase.kind === "idle", "宿主 phase 的 kind 保持不变（仍是空闲态）");
  assert(ctx.warnings.length === 0, "没有告警");
}

// ── 路径 2 边界：宿主快照与投影不一致 → 退回路径 3 ───────────────────────
// 两者读的是同一个 turnBoundary.lastTurn，不一致说明会话状态无法建模；
// 此时强行占号会让日志出现空洞（1 之后直接跳到 4）。
{
  console.log("路径 2 边界：宿主快照(7) ≠ 投影(0) → 不硬写:");
  const agent = { phase: { kind: "idle", lastTurn: 7 } };
  const ctx = makeCtx({ agent });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-2b", 0);
  emit(ctx, "session/created", session);
  assert(session.appended.length === 0, "不自开轮次（避免日志出现 1→4 的空洞）");
  assert(ctx.warnings.length === 1, "留下降级告警");
  assert(agent.phase.lastTurn === 7, "不动宿主的取号");
  hostAppend(ctx, session, "step/start", { turn: 4, step: 1 });
  const injected = session.appended.at(-1);
  assert(injected.type === "assistant/message", "退回路径 3，寄生到宿主轮次");
  assert(injected.data.turn === 4, "沿用宿主自己开的轮次号 4");
}

// ── 路径 2：宿主提供 setPhase 时优先走它 ────────────────────────────────
{
  console.log("路径 2：宿主提供 setPhase 时优先走它:");
  let calls = 0;
  const agent = {
    phase: { kind: "idle", lastTurn: 0 },
    setPhase(next) {
      calls += 1;
      this.phase = next;
    }
  };
  const ctx = makeCtx({ agent });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-2c", 0);
  emit(ctx, "session/created", session);
  assert(calls === 1, "调用了宿主的 setPhase");
  assert(agent.phase.lastTurn === 1, `取号被拨到 1（实际: ${agent.phase.lastTurn}）`);
  assert(agent.phase.kind === "idle", "kind 保持 idle");
}

// ── 路径 3：宿主已接管但取号状态不可预期 → 绝不自开轮次 ──────────────────
// 宁可晚一步，也不写出重复 turn：写成 1,1 会让按轮次归组的视图丢掉第一次问答。
{
  console.log("路径 3：宿主 phase 形态不认识 (agent.phase = {}):");
  const ctx = makeCtx({ agent: { phase: {} } });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-3", 0);
  emit(ctx, "session/created", session);

  assert(session.appended.length === 0, "创建时不写任何事件（不冒险占轮次）");
  assert(ctx.warnings.length === 1, `留下一条告警说明已降级（实际: ${ctx.warnings.length} 条）`);
  assert(/deferred/.test(ctx.warnings[0]), "告警说明问候已顺延");

  // 宿主自己开首轮：turn/start → step/start，应该在 step/start 上补问候
  hostAppend(ctx, session, "turn/start", { turn: 1 });
  assert(session.appended.length === 1, "turn/start 本身不触发注入（此时 step 还没开）");
  hostAppend(ctx, session, "step/start", { turn: 1, step: 1 });

  assert(session.appended.length === 3, "宿主 step/start 后立刻补上 1 条事件");
  const injected = session.appended[2];
  assert(injected.type === "assistant/message", "补的是 assistant/message");
  assert(injected.data.turn === 1 && injected.data.step === 1, "坐标沿用宿主自己开的 (turn=1, step=1)");
  assert(injected.data.message?.content?.[0]?.text === GREETING, "内容为问候文本");
  assert(Array.isArray(injected.data.stream) && injected.data.stream.length === 0, "stream 为空数组");
  assert(injected.opts?.surfaceOp === "append", "带 surfaceOp append");
  assert(
    session.appended.filter((e) => e.type === "turn/start").length === 1,
    "turn/start 只有宿主那一条（插件没有自开轮次）"
  );

  // 不重复注入：后续 step 不再补
  hostAppend(ctx, session, "step/end", { turn: 1, step: 1 });
  hostAppend(ctx, session, "step/start", { turn: 1, step: 2 });
  assert(
    session.appended.filter((e) => e.type === "assistant/message").length === 1,
    "只注入一次，后续 step 不再补"
  );
}

// ── 路径 3 变体：宿主正在运行（非空闲）也不自开轮次 ──────────────────────
{
  console.log("路径 3 变体：宿主正在运行 (phase.kind = 'running'):");
  const ctx = makeCtx({ agent: { phase: { kind: "running", turn: 1, step: 0 } } });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-3b", 0);
  emit(ctx, "session/created", session);
  assert(session.appended.length === 0, "不写事件");
  assert(ctx.warnings.length === 1, "留下降级告警");
}

// ── 已有轮次的会话：不问候、也不降级 ────────────────────────────────────
// session/created 在会话被迁移/恢复/重新装载时也会触发，此时日志里已经有轮次，
// 再插一条问候会污染原对话。
{
  console.log("已有轮次的会话 (turnBoundary.lastTurn = 3):");
  const ctx = makeCtx({ lastTurn: 3, agent: { phase: { kind: "idle", lastTurn: 3 } } });
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-restored", 0);
  emit(ctx, "session/created", session);
  assert(session.appended.length === 0, "已有轮次时不注入问候");
  assert(ctx.warnings.length === 0, "也不降级（本来就该跳过）");
}

// ── 带种子的会话：不问候 ────────────────────────────────────────────────
{
  console.log("带种子的会话 (isSeeded = true):");
  const ctx = makeCtx();
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-seeded", 0, { isSeeded: true, parentSession: "session-parent" });
  emit(ctx, "session/created", session);
  assert(session.appended.length === 0, "带种子会话不注入问候");
}

// ── 子智能体会话：跳过 ─────────────────────────────────────────────────
{
  console.log("子智能体会话 (delegationDepth=1):");
  const ctx = makeCtx();
  apply(ctx, DEFAULT_CONFIG);
  const session = makeSession(ctx, "sess-sub", 1);
  emit(ctx, "session/created", session);
  assert(session.appended.length === 0, "不注入问候");
}

// ── 自定义配置（路径 1）────────────────────────────────────────────────
{
  console.log("自定义 greeting/provider/model 配置:");
  const ctx = makeCtx();
  apply(ctx, { greeting: "欢迎使用自定义问候", provider: "my-provider", model: "my-model" });
  const session = makeSession(ctx, "sess-custom", 0);
  emit(ctx, "session/created", session);
  const msg = session.appended[2].data.message;
  assert(msg.content[0].text === "欢迎使用自定义问候", "使用配置的欢迎语");
  assert(msg.source.provider === "my-provider" && msg.source.model === "my-model", "使用配置的 provider/model");
}

// ── 自定义配置（路径 3）────────────────────────────────────────────────
{
  console.log("自定义配置 + 路径 3:");
  const ctx = makeCtx({ agent: { phase: { kind: "running" } } });
  apply(ctx, { greeting: "晚到的问候", provider: "p2", model: "m2" });
  const session = makeSession(ctx, "sess-custom-3", 0);
  emit(ctx, "session/created", session);
  hostAppend(ctx, session, "step/start", { turn: 1, step: 1 });
  const injected = session.appended.at(-1);
  assert(injected.data.message.content[0].text === "晚到的问候", "路径 3 也用配置的欢迎语");
  assert(
    injected.data.message.source.provider === "p2" && injected.data.message.source.model === "m2",
    "路径 3 也用配置的 provider/model"
  );
}

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
