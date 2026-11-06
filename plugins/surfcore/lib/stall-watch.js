/**
 * 卡死提醒看门狗（只提醒，不中止）
 *
 * 为什么需要它：2026-11-06 傍晚，两个长会话的模型请求在吐出第一个 chunk 之后
 * 静默挂起（111s / 224s），连接上只剩 SSE 心跳。DSH 的 streamIdleTimeoutMs 会被
 * 心跳续命，`assistant/message` 又只在整段结束后才落盘，所以宿主和界面都看不出
 * "这一轮已经很久没出字了"，用户看到的就是所有对话一起卡死。
 *
 * 判据（用户 2026-11-06 定的边界）：某个 step 连续 120 秒没有新内容，就记一条
 * "可能卡住了，建议停止"的提醒；**绝不主动 abort**，停不停由用户自己决定。
 *
 * 什么叫"新内容"：`agent/assistant-stream` 的 chunk 帧（模型每吐一个增量就有一帧）。
 * 工具执行期间（tool/call → tool/result）不算卡住，长命令本来就没字。
 */

/** 默认判定阈值：120 秒没有任何新内容。 */
export const STALL_DEFAULT_MS = 120_000;
/** 采样间隔：5 秒扫一次，保证提醒最多晚 5 秒。 */
export const STALL_SAMPLE_MS = 5_000;
/** 已经恢复的记录再多留 20 秒，让界面能显示"刚才卡过、现在恢复了"。 */
export const STALL_RECOVER_MS = 20_000;
/** 提醒记录最长保留 1 小时，防止 Map 无限增长。 */
export const STALL_KEEP_MS = 60 * 60_000;
/** 一次最多返回几条（界面只展示最新一条，其余用于诊断）。 */
const STALL_LIST_MAX = 5;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clip(value, max = 160) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 后台会话（QQ 桥接、子代理）不参与提醒：它们不是用户此刻正盯着的对话，
 * 而且 QQ 桥接自己有超时与重试。preset 名以 qq 开头即视为桥接会话。
 */
export function isBackgroundSession(session) {
  const header = session?.header ?? {};
  const preset = clip(header.agentPreset ?? session?.agentPreset ?? '', 80).toLowerCase();
  if (preset.startsWith('qq')) return true;
  if (clip(header.parentSession ?? '', 120)) return true;
  return false;
}

/** 会话标题：宿主 Session 没有 title getter，只能从 session 或 header 里取。 */
export function sessionTitle(session) {
  return clip(session?.title ?? session?.header?.title ?? '', 40);
}

/**
 * 创建看门狗。宿主侧只喂事件，不碰 UI；界面通过 snapshot() 轮询。
 *
 * @param {object} [options]
 * @param {number} [options.stallMs] 判定阈值（毫秒），默认 120000
 * @param {number} [options.sampleMs] 采样间隔（毫秒），默认 5000
 * @param {number} [options.recoverMs] 恢复后保留时长（毫秒），默认 20000
 * @param {number} [options.keepMs] 记录最长保留（毫秒），默认 3600000
 * @param {() => number} [options.now] 时钟，测试可注入
 * @param {(...args: unknown[]) => void} [options.log] 日志函数
 * @param {(session: object) => boolean} [options.include] 自定义过滤，返回 true 才监控
 */
export function createStallWatch({
  stallMs = STALL_DEFAULT_MS,
  sampleMs = STALL_SAMPLE_MS,
  recoverMs = STALL_RECOVER_MS,
  keepMs = STALL_KEEP_MS,
  now = () => Date.now(),
  log = () => {},
  include = null,
} = {}) {
  /** attemptId -> { sessionId, turn, step, startedAt, lastAt, warnedAt }（end 即删除） */
  const attempts = new Map();
  /** sessionId -> { id, title, phase, lastAt, attempts:Set<string>, background } */
  const sessions = new Map();
  /** stallId -> 提醒记录 */
  const stalls = new Map();

  let timer = null;
  let disposed = false;
  let tracked = 0;

  const threshold = Math.max(1_000, finite(stallMs, STALL_DEFAULT_MS));
  const sample = Math.max(1_000, Math.min(threshold, finite(sampleMs, STALL_SAMPLE_MS)));

  function trackedSession(session) {
    if (typeof include === 'function') {
      try {
        return Boolean(include(session));
      } catch {
        return false;
      }
    }
    return !isBackgroundSession(session);
  }

  function note(session) {
    if (!session || typeof session !== 'object') return null;
    const id = clip(session.id ?? '', 120);
    if (!id) return null;
    let state = sessions.get(id);
    if (!state) {
      state = { id, title: '', phase: 'model', lastAt: now(), attempts: new Set(), background: undefined };
      sessions.set(id, state);
    }
    // 顺手记下「这个会话要不要监控」：assistant-stream 事件只带 frame、不带 session 对象，
    // 没有这一步就永远分不清前台会话和 QQ / 子代理。
    state.background = !trackedSession(session);
    const title = sessionTitle(session);
    if (title) state.title = title;
    return state;
  }

  /** 喂一个 agent/assistant-stream 帧。 */
  function trackStream(payload) {
    if (disposed) return;
    const frame = payload?.frame;
    if (!frame || typeof frame !== 'object') return;
    const agent = payload?.agent;
    const session = agent?.session ?? payload?.session ?? null;
    const sessionId = clip(session?.id ?? frame.sessionId ?? '', 120);

    if (frame.type === 'start') {
      const key = clip(frame.attemptId ?? '', 120) || `${sessionId}:${frame.revision ?? 0}`;
      // 宿主发 agent/assistant-stream 时只带 frame（`{ frame }`，没有 agent/session），
      // 所以这里大多数时候拿不到 session 对象：后台会话靠 noteSessionEvent 记下的
      // background 标记来过滤；完全没见过的会话按「前台」处理（宁可提醒也别漏）。
      let state = session ? note(session) : (sessionId ? sessions.get(sessionId) : null);
      if (session && !trackedSession(session)) return;
      if (!session && state?.background === true) return;
      if (!state && sessionId) {
        state = { id: sessionId, title: '', phase: 'model', lastAt: now(), attempts: new Set(), background: undefined };
        sessions.set(sessionId, state);
      }
      attempts.set(key, {
        key,
        sessionId,
        turn: finite(frame.turn),
        step: finite(frame.step),
        startedAt: now(),
        lastAt: now(),
        warnedAt: 0,
      });
      if (state) {
        state.attempts.add(key);
        state.phase = 'model';
        state.lastAt = now();
      }
      tracked = attempts.size;
      return;
    }

    const key = clip(frame.attemptId ?? '', 120) || `${sessionId}:${frame.revision ?? 0}`;
    const attempt = attempts.get(key);
    if (!attempt) return;

    if (frame.type === 'chunk') {
      attempt.lastAt = now();
      const state = sessions.get(attempt.sessionId);
      if (state) state.lastAt = attempt.lastAt;
      if (attempt.warnedAt) {
        const record = stalls.get(key);
        if (record && !record.recoveredAt) record.recoveredAt = attempt.lastAt;
        attempt.warnedAt = 0;
      }
      return;
    }

    if (frame.type === 'end') {
      const state = sessions.get(attempt.sessionId);
      if (state) {
        state.attempts.delete(key);
        if (!state.attempts.size) state.phase = 'idle';
        state.lastAt = now();
      }
      // 一轮跑完就把它从表里删掉：以前只置 ended 标记，长会话下 attempts
      // 只增不减，tracked 也跟着一直涨（无界增长）。
      attempts.delete(key);
      tracked = attempts.size;
    }
  }

  /** 喂 session/event，用来知道工具在跑、以及 turn/step 的边界。 */
  function noteSessionEvent(session, event) {
    if (disposed || !event || typeof event !== 'object') return;
    const state = note(session);
    if (!state) return;
    if (!trackedSession(session)) return;

    switch (event.type) {
      case 'turn/start':
      case 'step/start':
        state.phase = 'model';
        state.lastAt = now();
        break;
      case 'tool/call':
        state.phase = 'tool';
        state.lastAt = now();
        break;
      case 'tool/result':
        state.phase = 'model';
        state.lastAt = now();
        break;
      case 'assistant/message':
      case 'assistant/attempt':
        state.phase = 'model';
        state.lastAt = now();
        break;
      case 'turn/end':
      case 'step/end':
        state.phase = 'idle';
        break;
      default:
        break;
    }
  }

  function warn(attempt, state) {
    const at = now();
    const idleMs = Math.max(threshold, at - attempt.lastAt);
    attempt.warnedAt = at;
    stalls.set(attempt.key, {
      id: `${attempt.key}:${at}`,
      sessionId: attempt.sessionId,
      title: state?.title ?? '',
      turn: attempt.turn,
      step: attempt.step,
      since: attempt.lastAt,
      warnedAt: at,
      idleMs,
      recoveredAt: 0,
    });
    try {
      log(`卡死提醒：会话 ${attempt.sessionId} 第 ${attempt.turn} 轮第 ${attempt.step} 步已 ${Math.round(idleMs / 1_000)}s 没有新内容`);
    } catch {
      /* 日志失败不影响判定 */
    }
  }

  function tick() {
    if (disposed) return;
    const at = now();
    for (const attempt of attempts.values()) {
      const state = sessions.get(attempt.sessionId);
      if (state && state.phase === 'tool') continue;
      if (attempt.warnedAt) continue;
      if (at - attempt.lastAt < threshold) continue;
      warn(attempt, state);
    }
    for (const [key, record] of stalls) {
      if (record.recoveredAt && at - record.recoveredAt > recoverMs) stalls.delete(key);
      else if (at - record.warnedAt > keepMs) stalls.delete(key);
    }
    // 万一 end 帧丢了（进程被杀、流断在半路），attempt 会永久留在表里：
    // 超过保留期一点动静都没有，就当它已经废了。
    for (const [key, attempt] of attempts) {
      if (at - attempt.lastAt <= keepMs) continue;
      const state = sessions.get(attempt.sessionId);
      if (state) {
        state.attempts.delete(key);
        if (!state.attempts.size) state.phase = 'idle';
      }
      attempts.delete(key);
    }
    // 会话表也要回收：跑完且超过保留期的会话留着没意义，一天下来能攒几千条。
    for (const [id, state] of sessions) {
      if (state.attempts.size) continue;
      if (state.phase !== 'idle') continue;
      if (at - state.lastAt <= keepMs) continue;
      sessions.delete(id);
    }
    tracked = attempts.size;
  }

  function start() {
    if (timer || disposed) return;
    timer = setInterval(tick, sample);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function dispose() {
    disposed = true;
    stop();
    attempts.clear();
    stalls.clear();
    sessions.clear();
    tracked = 0;
  }

  /** 界面轮询用的快照：最新一条提醒 + 条数 + 诊断信息。 */
  function snapshot() {
    const at = now();
    const list = [...stalls.values()].sort((left, right) => right.warnedAt - left.warnedAt).slice(0, STALL_LIST_MAX);
    return {
      ok: true,
      stallMs: threshold,
      sampledAt: at,
      tracked,
      count: stalls.size,
      stalls: list,
    };
  }

  return { start, stop, tick, dispose, trackStream, noteSessionEvent, snapshot, stalls, attempts, sessions };
}
