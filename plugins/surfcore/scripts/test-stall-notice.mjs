/**
 * 卡死提醒（客户端）回归：不启浏览器，验证两件事。
 *   1. apply() 真的把提示条注册进了 shell.overlay（名字和 id 都不能漂）。
 *   2. 拿到宿主快照后，组件渲染出来的文案是"可能卡住了"；恢复后换成"已经恢复"。
 *
 * 运行：node scripts/test-stall-notice.mjs
 */
import assert from 'node:assert/strict';

const idle = () => {};
let seed = [];
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useCallback: (fn) => fn,
  useEffect: idle,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => (seed.length ? [seed.shift(), idle] : [typeof initial === 'function' ? initial() : initial, idle]),
};

let client = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      client = factory((name) => (name === 'react' ? React : {}));
    },
  },
};

await import('../lib/client.js');
assert.ok(client, 'client.js 没有被 ModuleLoader 加载');
assert.equal(typeof client.StallNotice, 'function', 'StallNotice 没有导出');

// 1) 注册：必须挂到 shell.overlay，id 固定，切面板不丢
const registered = [];
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
};
client.apply(ctx);
const notice = registered.find((item) => item.options?.name === 'shell.overlay');
assert.ok(notice, 'apply() 没有注册 shell.overlay');
assert.equal(notice.options.id, 'surfcore-stall', 'shell.overlay 的 id 变了，前端去重会失效');
assert.equal(notice.component, client.StallNotice, '注册的组件不是 StallNotice');

// 2) 渲染：卡住时给"可能卡住了"，恢复后给"已经恢复"
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && Array.isArray(node.children)) return node.children.map(textOf).join('');
  return '';
}

const stalled = {
  id: 'a1:0',
  sessionId: 's1',
  title: '会话一',
  turn: 3,
  step: 2,
  since: Date.now() - 130_000,
  warnedAt: Date.now(),
  idleMs: 130_000,
  recoveredAt: 0,
};
seed = [stalled, null, 0];
const stuckText = textOf(client.StallNotice());
assert.match(stuckText, /可能卡住了/u, `卡住文案不对：${stuckText}`);
assert.match(stuckText, /会话一/u, '没带会话标题');
assert.match(stuckText, /建议/u, '没给"建议停止"的指引');

seed = [{ ...stalled, recoveredAt: Date.now() }, null, Date.now()];
const recoveredText = textOf(client.StallNotice());
assert.match(recoveredText, /已经恢复/u, `恢复文案不对：${recoveredText}`);
assert.doesNotMatch(recoveredText, /可能卡住了/u);

// 3) 没有卡住记录时什么都不渲染（不能挡住界面）
seed = [null, null, 0];
assert.equal(client.StallNotice(), null);

console.log('✅ test-stall-notice 全部通过');
