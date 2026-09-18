/**
 * dsh-welcome 逻辑单元测试：不依赖完整 harness，直接用 mock ctx/session
 * 验证 Config 默认值与 apply() 在 session/created 时的行为。
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

function makeCtx(lastTurn = 0) {
  const listeners = new Map();
  const warnings = [];
  return {
    listeners,
    warnings,
    ctx: {
      on(event, cb, opts) {
        listeners.set(event, { cb, opts });
      },
      logger: {
        warn: (...args) => warnings.push(args.join(" "))
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
      }
    }
  };
}

function makeSession(id, delegationDepth, headerExtra = {}) {
  const appended = [];
  return {
    id,
    appended,
    header: { id, delegationDepth, isSeeded: false, ...headerExtra },
    append(type, data, opts) {
      appended.push({ type, data, opts });
    }
  };
}

const GREETING = "Hello,欢迎来到DSH";

// ── Config schema 默认值 ───────────────────────────────────────────────
{
  console.log("Config schema 默认值:");
  const resolved = Config({});
  assert(resolved.greeting === GREETING, `默认欢迎语为 "${GREETING}"（实际: ${resolved.greeting}）`);
  assert(resolved.provider === "deepseek-official" && resolved.model === "deepseek-v4-flash", "默认 provider/model 正确");
}

// ── 顶层会话：应该注入一个完整合成助手轮次 ────────────────────────────────
{
  console.log("顶层会话 (delegationDepth=0):");
  const { ctx, listeners } = makeCtx();
  apply(ctx, { greeting: GREETING, provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert(listeners.has("session/created"), "注册了 session/created 监听");
  assert(listeners.get("session/created").opts?.global === true, "监听是全局的 ({global:true})");

  const session = makeSession("sess-1", 0);
  listeners.get("session/created").cb(session);

  assert(session.appended.length === 5, "恰好追加 5 个事件（完整轮次）");
  const types = session.appended.map((e) => e.type);
  assert(
    JSON.stringify(types) === JSON.stringify(["turn/start", "step/start", "assistant/message", "step/end", "turn/end"]),
    `事件顺序正确: ${types.join(" → ")}`
  );
  // 轮次号必须是正整数：dsh 会话格式要求 turn/step >= 1 且按日志顺序严格连续。
  // 写 turn:0 会让整份日志无法从 v2 迁移到 v3（web 端历史加载失败）。
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
  assert(msg.source?.provider === "deepseek-official" && msg.source?.model === "deepseek-v4-flash", "带 provider/model 溯源");
  assert(msg.content?.[0]?.type === "text" && msg.content[0].text === GREETING, "内容为问候文本");
  assert(session.appended[3].data.step === 1, "step/end 关闭 step 1");
  assert(session.appended[4].data.reason?.kind === "completed", "turn/end 以 completed 关闭");
}

// ── 已有轮次的会话：不应该问候 ────────────────────────────────────────────
// session/created 在会话被迁移/恢复/重新装载时也会触发，此时日志里已经有轮次，
// 再插一条问候会污染原对话，并留下不合规的 turn:0 事件。
{
  console.log("已有轮次的会话 (turnBoundary.lastTurn = 3):");
  const { ctx, listeners } = makeCtx(3);
  apply(ctx, { greeting: GREETING, provider: "deepseek-official", model: "deepseek-v4-flash" });
  const session = makeSession("sess-restored", 0);
  listeners.get("session/created").cb(session);
  assert(session.appended.length === 0, "已有轮次时不注入问候");
}

// ── 带种子的会话：不应该问候 ──────────────────────────────────────────────
{
  console.log("带种子的会话 (isSeeded = true):");
  const { ctx, listeners } = makeCtx(0);
  apply(ctx, { greeting: GREETING, provider: "deepseek-official", model: "deepseek-v4-flash" });
  const session = makeSession("sess-seeded", 0, { isSeeded: true, parentSession: "session-parent" });
  listeners.get("session/created").cb(session);
  assert(session.appended.length === 0, "带种子会话不注入问候");
}

// ── 子智能体会话：应该跳过 ─────────────────────────────────────────────
{
  console.log("子智能体会话 (delegationDepth=1):");
  const { ctx, listeners } = makeCtx();
  apply(ctx, { greeting: GREETING, provider: "deepseek-official", model: "deepseek-v4-flash" });
  const session = makeSession("sess-2", 1);
  listeners.get("session/created").cb(session);
  assert(session.appended.length === 0, "不注入问候");
}

// ── 自定义配置 ─────────────────────────────────────────────────────────
{
  console.log("自定义 greeting/provider/model 配置:");
  const { ctx, listeners } = makeCtx();
  apply(ctx, { greeting: "欢迎使用自定义问候", provider: "my-provider", model: "my-model" });
  const session = makeSession("sess-3", 0);
  listeners.get("session/created").cb(session);
  const msg = session.appended[2].data.message;
  assert(msg.content[0].text === "欢迎使用自定义问候", "使用配置的欢迎语");
  assert(msg.source.provider === "my-provider" && msg.source.model === "my-model", "使用配置的 provider/model");
}

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
