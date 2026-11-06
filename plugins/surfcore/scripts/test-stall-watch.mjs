/** 卡死看门狗回归：连续 120 秒没新内容才提醒、工具阶段不提醒、恢复后标记、后台会话不提醒、结束的 attempt 不再提醒。 */
import assert from 'node:assert/strict';
import { createStallWatch, isBackgroundSession } from '../lib/stall-watch.js';

let clock = 0;
const now = () => clock;

function frame(type, extra = {}) {
  return { type, attemptId: 'a1', revision: 1, turn: 3, step: 2, index: 0, time: clock, chunk: 'x', ...extra };
}

function makeWatch(options = {}) {
  return createStallWatch({ now, stallMs: 120_000, sampleMs: 1_000, recoverMs: 20_000, log: () => {}, ...options });
}

const session = { id: 's1', title: '会话一', header: { agentPreset: 'standard' } };
const agent = { session };
const feed = (type, extra) => ({ agent, frame: frame(type, extra) });

// 1) 120 秒是硬门槛：差 1 秒不提醒，到了就提醒，且同一 attempt 只提醒一次
{
  const watch = makeWatch();
  watch.trackStream(feed('start'));
  clock += 119_000;
  watch.trackStream(feed('chunk', { index: 1 }));
  clock += 1_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, '119 秒不应该提醒');

  clock += 120_000;
  watch.tick();
  const snap = watch.snapshot();
  assert.equal(snap.count, 1, '连续 120 秒没有新 chunk 要提醒');
  assert.equal(snap.stalls[0].sessionId, 's1');
  assert.equal(snap.stalls[0].title, '会话一');
  assert.equal(snap.stalls[0].turn, 3);
  assert.equal(snap.stalls[0].step, 2);
  assert.ok(snap.stalls[0].idleMs >= 120_000, '要记下卡了多久');

  clock += 300_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 1, '同一个 attempt 不能反复刷提醒');
  watch.dispose();
}

// 2) 工具执行期间不算卡住；工具结束后仍没新内容要提醒
{
  const watch = makeWatch();
  watch.trackStream(feed('start'));
  watch.noteSessionEvent(session, { type: 'tool/call' });
  clock += 600_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, '跑长命令不算模型卡住');

  watch.noteSessionEvent(session, { type: 'tool/result' });
  watch.trackStream(feed('chunk', { index: 2 }));
  clock += 119_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0);
  clock += 2_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 1, '工具结束后没新内容依然要提醒');
  watch.dispose();
}

// 3) 恢复后标记 recoveredAt，过了保留期就清掉
{
  const watch = makeWatch();
  watch.trackStream(feed('start'));
  clock += 120_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 1);

  clock += 1_000;
  watch.trackStream(feed('chunk', { index: 1 }));
  const recovered = watch.snapshot().stalls[0];
  assert.ok(recovered.recoveredAt > 0, '恢复后要标记 recoveredAt');

  clock += 21_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, '恢复 20 秒后记录要清掉');
  watch.dispose();
}

// 4) QQ 桥接会话与子代理不提醒（不是用户正盯着的对话）
{
  const watch = makeWatch();
  const qqSession = { id: 'qq1', header: { agentPreset: 'qq-chat-v2' } };
  const child = { id: 'c1', header: { agentPreset: 'standard', parentSession: 'p1' } };
  watch.trackStream({ agent: { session: qqSession }, frame: frame('start', { attemptId: 'q1' }) });
  watch.trackStream({ agent: { session: child }, frame: frame('start', { attemptId: 'c2' }) });
  clock += 300_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, 'QQ 会话和子代理不提醒');
  assert.equal(isBackgroundSession(qqSession), true);
  assert.equal(isBackgroundSession(child), true);
  assert.equal(isBackgroundSession(session), false);
  watch.dispose();
}

// 5) 已结束的 attempt 不再提醒，并从表里删掉；脏数据不炸
{
  const watch = makeWatch();
  assert.doesNotThrow(() => watch.trackStream(null));
  assert.doesNotThrow(() => watch.trackStream({ frame: { type: 'chunk' } }));
  assert.doesNotThrow(() => watch.noteSessionEvent(null, null));

  watch.trackStream(feed('start'));
  watch.trackStream(feed('end', { outcome: { kind: 'committed' } }));
  clock += 600_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, '已结束的 attempt 不再提醒');
  assert.equal(watch.attempts.has('a1'), false, '结束的 attempt 要直接删掉，不能只标 ended');
  watch.dispose();
}

// 6) 宿主只发 frame（没有 agent/session）也要能跟踪——真实的 agent/assistant-stream 就是 `{ frame }`
{
  const watch = makeWatch();
  watch.trackStream({ frame: frame('start', { attemptId: 'bare', sessionId: 's1' }) });
  assert.equal(watch.snapshot().tracked, 1, '只有 frame 时必须照样跟踪');
  clock += 130_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 1, '只有 frame 时超时也要提醒');
  watch.dispose();
}

// 6b) QQ / 子代理：从 session/event 学会 background 后，只带 frame 的流事件不再跟踪
{
  const watch = makeWatch();
  const qqSession = { id: 'qq2', header: { agentPreset: 'qq-chat-v2' } };
  watch.noteSessionEvent(qqSession, { type: 'turn/start' });
  watch.trackStream({ frame: frame('start', { attemptId: 'q1', sessionId: 'qq2' }) });
  assert.equal(watch.snapshot().tracked, 0, 'QQ 会话不跟踪');
  clock += 600_000;
  watch.tick();
  assert.equal(watch.snapshot().count, 0, 'QQ 会话不提醒');
  watch.dispose();
}

// 7) 长跑不涨内存：attempt 跑完即删，空闲会话过了保留期回收
{
  const watch = makeWatch();
  for (let i = 0; i < 50; i += 1) {
    watch.trackStream(feed('start', { attemptId: `loop-${i}` }));
    watch.trackStream(feed('end', { attemptId: `loop-${i}`, outcome: { kind: 'committed' } }));
  }
  assert.equal(watch.attempts.size, 0, 'attempts 不能只增不减');
  assert.equal(watch.snapshot().tracked, 0);

  watch.trackStream(feed('start', { attemptId: 'x' }));
  watch.trackStream(feed('end', { attemptId: 'x' }));
  assert.equal(watch.sessions.size, 1, '会话表里还留着刚跑完的会话');
  clock += 60 * 60 * 1000 + 1;
  watch.tick();
  assert.equal(watch.sessions.size, 0, '空闲超过保留期的会话要回收');
  watch.dispose();
}

console.log('✅ test-stall-watch 全部通过');
