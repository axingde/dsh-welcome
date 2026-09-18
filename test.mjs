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

function makeCtx() {
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
      }
    }
  };
}

function makeSession(id, delegationDepth) {
  const appended = [];
  return {
    id,
    appended,
    header: { id, delegationDepth },
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
  assert(session.appended[0].data.turn === 0 && session.appended[1].data.turn === 0 && session.appended[1].data.step === 0, "轮次编号 turn 0 / step 0");
  const msgEvent = session.appended[2];
  assert(msgEvent.opts?.surfaceOp === "append", "assistant/message 带 surfaceOp append");
  const msg = msgEvent.data.message;
  assert(msg.role === "assistant", "消息 role 为 assistant");
  assert(typeof msg.id === "string" && msg.id !== "", "消息带稳定 id");
  assert(msg.source?.kind === "model", "消息 source 为 model");
  assert(msg.source?.provider === "deepseek-official" && msg.source?.model === "deepseek-v4-flash", "带 provider/model 溯源");
  assert(msg.content?.[0]?.type === "text" && msg.content[0].text === GREETING, "内容为问候文本");
  assert(session.appended[3].data.step === 0, "step/end 关闭 step 0");
  assert(session.appended[4].data.reason?.kind === "completed", "turn/end 以 completed 关闭");
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
