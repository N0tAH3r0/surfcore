#!/usr/bin/env node
/**
 * 记忆合并：把一张角色卡的记忆并到另一张卡，切换角色不断档。
 *
 *   node scripts/merge-memory.mjs --from <id|current> --to <id|current> [--dry-run] [--replace]
 *
 *   --from      记忆来源（老卡）
 *   --to        记忆目标（新卡 / 当前在用的卡）
 *   --dry-run   只算不动，打印会合并多少条
 *   --replace   不做并集，直接用来源卡覆盖目标卡的记忆（目标原记忆仍会先整份备份）
 *
 * 合并的东西：
 *   memory-card.json        逐条并集（按 id，再用 时间+正文 兜底去重）
 *   memory-card-full.jsonl  全量档案逐行并集（按 id 去重）
 *   meta / stats            相遇锚点、inbox 去重表、来源计数一并合并
 * 不合并的东西：
 *   memory-inbox.jsonl      在途队列（最多 10 分钟量），合并会重复，交给维护任务自然补
 *
 * 合并完会用 memory-card.js 自己的渲染器重写 memory-card.md 与三份注入块，
 * 所以格式、字数上限、按群隔离都跟运行时完全一致。
 *
 * 合并前会把目标卡整个 memory 目录复制到 <surfcore>/backups/merge-memory-<时间>/，
 * 想回滚直接把那个目录拷回去即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { characterPaths, readCurrentCharacter, readIndex, SURFCORE_DIR } from '../src/character-persona.js';
import {
  loadMemoryCard, saveMemoryCardOutputs, normalizeMemoryCardConfig, createEmptyCard,
} from '../src/memory-card.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] ?? '').trim() : '';
};

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function listCharacters() {
  const index = readIndex();
  const current = readCurrentCharacter();
  const rows = (index?.characters ?? []).map((c) => {
    const dir = characterPaths(c.id);
    const card = loadMemoryCard({ json: path.join(dir.memoryDir, 'memory-card.json') });
    const mark = c.id === current?.id ? ' ← 当前' : '';
    return `  ${c.id.padEnd(16)} ${String(c.name).padEnd(10)} 记忆 ${String(card?.records?.length ?? 0).padStart(4)} 条${mark}`;
  });
  console.log('可用的角色卡：');
  console.log(rows.join('\n') || '  （无）');
}

function resolveId(raw, flagName) {
  const value = String(raw ?? '').trim();
  if (!value) die(`缺少 --${flagName} <卡 id>（用 --list 查看）`);
  const current = readCurrentCharacter();
  if (value === 'current' || value === '当前') {
    if (!current) die('当前没有选中的角色卡');
    return current.id;
  }
  const known = new Set((readIndex()?.characters ?? []).map((c) => c.id));
  if (!known.has(value)) die(`找不到角色卡 ${value}（用 --list 查看）`);
  return value;
}

function memoryPathsOf(id) {
  const dir = characterPaths(id);
  return {
    id,
    dir: dir.memoryDir,
    json: path.join(dir.memoryDir, 'memory-card.json'),
    markdown: path.join(dir.memoryDir, 'memory-card.md'),
    promptQq: path.join(dir.memoryDir, 'memory-card-prompt-qq.md'),
    promptBili: path.join(dir.memoryDir, 'memory-card-prompt-bili.md'),
    fullJsonl: path.join(dir.memoryDir, 'memory-card-full.jsonl'),
    fullStats: path.join(dir.memoryDir, 'memory-card-full-stats.json'),
    fullMarkdown: path.join(dir.memoryDir, 'memory-card-full.md'),
    inbox: path.join(dir.memoryDir, 'memory-inbox.jsonl'),
  };
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function recordKey(record) {
  const id = String(record?.id ?? '').trim();
  if (id) return `id:${id}`;
  return `txt:${String(record?.createdAt ?? '')}|${String(record?.text ?? '')}|${String(record?.speaker ?? '')}`;
}

function union(arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    for (const item of arr ?? []) {
      const key = String(item ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function earliest(a, b) {
  const ta = Date.parse(String(a ?? ''));
  const tb = Date.parse(String(b ?? ''));
  if (!Number.isFinite(ta)) return b || '';
  if (!Number.isFinite(tb)) return a || '';
  return ta <= tb ? a : b;
}

function backupDir(srcDir, stamp) {
  const dest = path.join(SURFCORE_DIR, 'backups', `merge-memory-${stamp}`);
  // 目标卡可能还没有记忆目录（新卡、或只存过 meta），这时没有东西可备份，
  // 以前直接 readdirSync 会抛 ENOENT 把整个合并中断。
  if (!fs.existsSync(srcDir)) return null;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
  return dest;
}

/** 合并两张卡，返回 { card, added, replaced } */
function mergeCards(fromCard, toCard, { replace = false, now = Date.now() } = {}) {
  if (replace) {
    return {
      card: {
        ...toCard,
        records: fromCard.records.map((r) => ({ ...r })),
        meta: { ...fromCard.meta },
        stats: { ...fromCard.stats },
        updatedAt: new Date(now).toISOString(),
        lastMaintenanceAt: toCard.lastMaintenanceAt || fromCard.lastMaintenanceAt,
        lastDecayDate: toCard.lastDecayDate || fromCard.lastDecayDate,
      },
      added: fromCard.records.length,
      replaced: true,
    };
  }

  const keys = new Set(toCard.records.map(recordKey));
  const added = [];
  for (const record of fromCard.records) {
    const key = recordKey(record);
    if (keys.has(key)) continue;
    keys.add(key);
    added.push({ ...record });
  }

  const card = {
    ...toCard,
    records: [...toCard.records, ...added].sort(
      (a, b) => (Date.parse(String(a.createdAt ?? '')) || 0) - (Date.parse(String(b.createdAt ?? '')) || 0),
    ),
    meta: {
      ...toCard.meta,
      inboxSeen: union([fromCard.meta.inboxSeen, toCard.meta.inboxSeen]).slice(-5000),
      sourceSeen: union([fromCard.meta.sourceSeen, toCard.meta.sourceSeen]).slice(-5000),
      firstOwnerAt: earliest(toCard.meta.firstOwnerAt, fromCard.meta.firstOwnerAt),
      firstOwnerRecordId: toCard.meta.firstOwnerRecordId || fromCard.meta.firstOwnerRecordId,
      firstMetSource: toCard.meta.firstMetSource || fromCard.meta.firstMetSource,
      firstMetAt: toCard.meta.firstMetAt || fromCard.meta.firstMetAt,
      firstMetRecordIds: union([fromCard.meta.firstMetRecordIds, toCard.meta.firstMetRecordIds]).slice(0, 20),
      firstMetEventId: toCard.meta.firstMetEventId || fromCard.meta.firstMetEventId,
    },
    stats: {
      ...toCard.stats,
      ingested: (Number(toCard.stats.ingested) || 0) + added.length,
      fromQq: (Number(toCard.stats.fromQq) || 0) + added.filter((r) => String(r.platform) === 'qq').length,
      fromBili: (Number(toCard.stats.fromBili) || 0) + added.filter((r) => String(r.platform) === 'bili').length,
      lastIngestAt: new Date(now).toISOString(),
    },
    updatedAt: new Date(now).toISOString(),
  };
  return { card, added: added.length, replaced: false };
}

function mergeFullArchive(fromPaths, toPaths) {
  const toLines = readJsonl(toPaths.fullJsonl);
  const seen = new Set();
  for (const line of toLines) {
    try {
      const rec = JSON.parse(line);
      seen.add(recordKey(rec));
    } catch {}
  }
  const addedLines = [];
  for (const line of readJsonl(fromPaths.fullJsonl)) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const key = recordKey(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    addedLines.push(line);
  }
  if (addedLines.length) {
    fs.writeFileSync(toPaths.fullJsonl, `${[...toLines, ...addedLines].join('\n')}\n`, 'utf8');
  }
  // 重算全量卡 stats，保持和运行时一致
  const records = [];
  for (const line of readJsonl(toPaths.fullJsonl)) {
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  const counts = { owner: 0, bili: 0, qq: 0, other: 0 };
  let chars = 0;
  for (const rec of records) {
    chars += String(rec?.text ?? '').length;
    const platform = String(rec?.platform ?? '');
    if (rec?.isOwner === true || String(rec?.source ?? '').includes('owner')) counts.owner += 1;
    else if (platform === 'bili') counts.bili += 1;
    else if (platform === 'qq') counts.qq += 1;
    else counts.other += 1;
  }
  const prevStats = (() => {
    try {
      return JSON.parse(fs.readFileSync(toPaths.fullStats, 'utf8'));
    } catch {
      return {};
    }
  })();
  const stats = {
    version: 2,
    kind: 'full',
    createdAt: prevStats.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    records: records.length,
    chars,
    bytes: fs.existsSync(toPaths.fullJsonl) ? fs.statSync(toPaths.fullJsonl).size : 0,
    counts,
    lastArchiveAt: prevStats.lastArchiveAt || new Date().toISOString(),
    lastMigratedAt: prevStats.lastMigratedAt ?? null,
  };
  fs.writeFileSync(toPaths.fullStats, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return { addedLines: addedLines.length, records: records.length };
}

function main() {
  if (flag('list') || argv.length === 0) {
    listCharacters();
    return;
  }
  const fromId = resolveId(opt('from'), 'from');
  const toId = resolveId(opt('to'), 'to');
  if (fromId === toId) die('--from 和 --to 是同一张卡');
  const dryRun = flag('dry-run');
  const replace = flag('replace');

  const from = memoryPathsOf(fromId);
  const to = memoryPathsOf(toId);
  const fromCard = loadMemoryCard(from);
  if (!fromCard) die(`来源卡 ${fromId} 没有可用的 memory-card.json`);
  const toCard = loadMemoryCard(to) ?? createEmptyCard();
  const cfg = (() => {
    try {
      return normalizeMemoryCardConfig(JSON.parse(fs.readFileSync(path.join(SURFCORE_DIR, 'config.json'), 'utf8'))?.memoryCard ?? {});
    } catch {
      return normalizeMemoryCardConfig({});
    }
  })();

  const { card, added, replaced } = mergeCards(fromCard, toCard, { replace, now: Date.now() });
  const fromLines = readJsonl(from.fullJsonl).length;
  const toLines = readJsonl(to.fullJsonl).length;

  console.log(`来源：${fromId}（记忆 ${fromCard.records.length} 条 / 全量 ${fromLines} 行）`);
  console.log(`目标：${toId}（记忆 ${toCard.records.length} 条 / 全量 ${toLines} 行）`);
  console.log(replaced
    ? `模式：覆盖（目标原记忆会先备份）`
    : `模式：并集（预计新增 ${added} 条）`);

  if (dryRun) {
    console.log('— dry-run：没有写入任何文件');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = backupDir(to.dir, stamp);
  console.log(backup ? `✓ 已备份目标记忆目录 → ${backup}` : '· 目标还没有记忆目录，跳过备份');

  saveMemoryCardOutputs(to, card, cfg, Date.now());
  const full = mergeFullArchive(from, to);
  console.log(`✓ 记忆卡：${card.records.length} 条（新增 ${added} 条）`);
  console.log(`✓ 全量档案：${full.records} 条（新增 ${full.addedLines} 行）`);
  console.log(`✓ 已重绘 memory-card.md / prompt-qq / prompt-bili / prompt-qq-groups`);
  console.log(`  回滚：把 ${backup} 里的文件拷回 ${to.dir}`);
}

main();
