/**
 * 角色人格存储层单测：多角色隔离 / 切换 epoch / 快照回档 / 旧数据迁移。
 * 全部在临时 DSH_HOME 里跑，不碰真实角色与记忆。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-character-home-'));
process.env.DSH_HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import('../src/character-persona.js');

const memoryCard = (text) => ({
  version: 1,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  meta: { inboxSeen: [], sourceSeen: [], firstOwnerAt: '' },
  alerts: { level: 0, acknowledgedLevel: 0, lastNotified: {} },
  stats: { fromQq: 1, fromBili: 0, forgotten: 0 },
  records: [{
    id: `mem_${text}`, source: 'manual', sourceId: '', platform: 'qq', scope: 'qq', kind: 'manual',
    text, title: text, detail: '', speaker: '主人', isOwner: true, isPrivate: true, direct: true,
    tags: ['owner'], importance: 80, clarity: 'vivid', createdAt: '2026-10-23T00:00:00.000Z',
    lastSeenAt: '2026-10-23T00:00:00.000Z', recallCount: 0, pinned: false, anchor: false,
  }],
});

const a = store.createCharacter({ name: '角色甲', personaText: '# 角色卡：甲\n\n甲的人格。', memoryCard: memoryCard('甲的记忆') });
const b = store.createCharacter({ name: '角色乙', personaText: '# 角色卡：乙\n\n乙的人格。', memoryCard: memoryCard('乙的记忆') });
assert.notEqual(a.character.id, b.character.id);

// 1) 切换 + epoch：每次切换必须 +1，当前角色可解析。
const first = store.switchCharacter(a.character.id);
const second = store.switchCharacter(b.character.id);
assert.equal(first.current.id, a.character.id);
assert.equal(second.current.id, b.character.id);
assert.ok(second.current.epoch > first.current.epoch, '切换角色必须递增 epoch');
assert.equal(store.isCurrentEpoch(second.current.epoch), true);
assert.equal(store.isCurrentEpoch(first.current.epoch), false);
assert.equal(store.readCurrentCharacter().id, b.character.id);

// 2) 记忆路径隔离：同一个固定文件名，在不同角色目录下是不同文件。
const pathsA = store.characterPaths(a.character.id);
const pathsB = store.characterPaths(b.character.id);
fs.writeFileSync(pathsA.memoryPromptQq, 'A 的注入块');
fs.writeFileSync(pathsB.memoryPromptQq, 'B 的注入块');
assert.equal(fs.readFileSync(store.activeMemoryPaths().promptQq, 'utf8'), 'B 的注入块');
assert.notEqual(store.activeMemoryPaths().dir, pathsA.memoryDir);
assert.equal(store.activeBiliDir(), pathsB.biliDir);

// 2.1 行为账本隔离：A 的 quota 不能出现在 B 的角色目录里。
store.switchCharacter(a.character.id);
fs.writeFileSync(path.join(pathsA.biliDir, 'quota.json'), '{"owner":"A"}');
store.switchCharacter(b.character.id);
assert.equal(fs.existsSync(path.join(pathsB.biliDir, 'quota.json')), false, 'B 不应看到 A 的行为账本');
store.switchCharacter(a.character.id);
assert.equal(fs.readFileSync(path.join(pathsA.biliDir, 'quota.json'), 'utf8'), '{"owner":"A"}');
store.switchCharacter(b.character.id);

// 3) 快照 + 回档：只回人格/衰减记忆/行为账本，不回全量 append-only 档案。
fs.writeFileSync(pathsB.biliDir + '/quota.json', '{"date":"2026-10-23","log":[]}');
const snap = store.snapshotCharacter(b.character.id, { slot: 'auto-180d', reason: 'auto' });
assert.ok(fs.existsSync(path.join(snap.dir, 'persona.md')));
fs.writeFileSync(pathsB.persona, '被改坏的人格');
fs.writeFileSync(pathsB.memoryJson, JSON.stringify(memoryCard('被改坏的记忆')));
store.restoreSnapshot(b.character.id, 'auto-180d');
assert.equal(fs.readFileSync(pathsB.persona, 'utf8').trim(), '# 角色卡：乙\n\n乙的人格。');
assert.match(fs.readFileSync(pathsB.memoryJson, 'utf8'), /乙的记忆/);
assert.ok(fs.readdirSync(pathsB.snapshotsDir).some((name) => name.startsWith('pre-restore-')), '回档前必须自动备份');

// 3.1 自动存档轮换：11 个年龄档 + before-switch，不无限增长。
const characters = await import('../plugins/surfcore/lib/characters.js');
const c3 = store.createCharacter({ name: '轮换测试', personaText: '# 卡' });
const now = Date.now();
for (let i = 0; i < 15; i += 1) {
  store.snapshotCharacter(c3.character.id, { slot: `auto-day-${i}`, reason: 'auto', now: now - i * 86400000 });
}
characters.autoSnapshot(c3.character.id, { now });
const autos = store.listSnapshots(c3.character.id).filter((item) => item.slot.startsWith('auto-'));
assert.ok(autos.length <= 11, `自动存档应轮换到 11 档，实得 ${autos.length}`);
assert.ok(autos.some((item) => /auto-day-1$/.test(item.slot) || item.slot === `auto-${new Date(now).toISOString().slice(0, 10)}`), '最近一档应保留');

// 4) 旧布局迁移：人格卡 + 记忆卡 + B站行为账本进第一个角色，旧目录保留。
const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-character-legacy-'));
const legacyMemory = path.join(legacyHome, 'memory');
const legacyBili = path.join(legacyHome, 'bili');
fs.mkdirSync(legacyMemory, { recursive: true });
fs.mkdirSync(legacyBili, { recursive: true });
const legacyPersona = path.join(legacyHome, 'legacy-role.md');
fs.writeFileSync(legacyPersona, '# 角色卡：旧角色\n\n旧人格。');
fs.writeFileSync(path.join(legacyMemory, 'memory-card.json'), JSON.stringify(memoryCard('旧记忆')));
fs.writeFileSync(path.join(legacyMemory, 'memory-inbox.jsonl'), '{"text":"旧 inbox"}\n');
fs.writeFileSync(path.join(legacyBili, 'quota.json'), '{"date":"2026-10-22","log":[]}');
fs.writeFileSync(path.join(legacyBili, 'credentials.json'), '{"sessdata":"must-not-migrate"}');

// 换一个独立 DSH_HOME，避免和上面的角色冲突。
const migrationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-character-migrate-'));
process.env.DSH_HOME = migrationHome;
const store2 = await import(`../src/character-persona.js?migrate=${Date.now()}`);
const migrated = store2.migrateLegacy({
  personaFile: legacyPersona,
  memoryDir: legacyMemory,
  biliDir: legacyBili,
  name: '旧角色',
});
assert.equal(migrated.migrated, true);
assert.equal(store2.readCurrentCharacter().name, '旧角色');
const migratedPaths = store2.characterPaths(migrated.character.id);
assert.match(fs.readFileSync(migratedPaths.persona, 'utf8'), /旧人格/);
assert.match(fs.readFileSync(migratedPaths.memoryJson, 'utf8'), /旧记忆/);
assert.equal(fs.readFileSync(path.join(migratedPaths.biliDir, 'quota.json'), 'utf8'), '{"date":"2026-10-22","log":[]}');
assert.equal(fs.existsSync(path.join(migratedPaths.biliDir, 'credentials.json')), false, '凭证不能进角色包');
assert.equal(fs.existsSync(path.join(legacyMemory, 'memory-card.json')), true, '旧数据必须保留（不删除）');
assert.ok(migrated.backupDir && fs.existsSync(migrated.backupDir), '迁移必须留备份目录');
assert.equal(store2.migrateLegacy({ personaFile: legacyPersona, memoryDir: legacyMemory, biliDir: legacyBili }).skipped, true, '迁移必须幂等');

// 3) 改人格卡前的备份：同一秒里连改两次也要各留一版（曾经撞时间戳就吞掉第二版）
{
  store.switchCharacter(a.character.id);
  // 固定同一个 now：保证两次备份时间戳完全一样，跨秒才不会掩盖问题
  const fixedNow = Date.now();
  store.updateCharacter(a.character.id, { personaText: '# 备份测试 第一版', now: fixedNow });
  store.updateCharacter(a.character.id, { personaText: '# 备份测试 第二版', now: fixedNow });
  const backups = fs.readdirSync(store.PERSONA_BACKUP_DIR).filter((name) => name.includes('-改前'));
  assert.ok(backups.length >= 2, `连改两次要留两版备份，实际 ${backups.join(', ')}`);
  const texts = backups.map((name) => fs.readFileSync(path.join(store.PERSONA_BACKUP_DIR, name), 'utf8'));
  assert.ok(texts.some((text) => text.includes('备份测试 第一版')), '第一版必须被备份下来');
  assert.ok(fs.existsSync(path.join(store.PERSONA_BACKUP_DIR, 'index.md')), '备份目录要有 index.md');
}

for (const dir of [tempHome, legacyHome, migrationHome]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log('character store tests OK');
