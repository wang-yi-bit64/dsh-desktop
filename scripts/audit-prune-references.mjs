#!/usr/bin/env node
/**
 * audit-prune-references.mjs — 一次性审计：瘦身删掉的文件里，有没有被**存活文件** require / import 的路径。
 *
 * 动机：`pruneNodeModules()` 的判据只能按「目录名 + 文件后缀」判定开发产物，
 * 无法知道某个路径是否**在运行时被引用**。`yaml/dist/doc/directives.js` 那次事故
 * 就是判据看不见引用关系造成的。这个脚本把引用关系**显式**算出来：
 *
 *   1. 在内存里跑一遍 prune 的判定逻辑，得到「会被删除的路径集合」D；
 *   2. 遍历所有**不会被删除**的 .js/.cjs/.mjs，抽出相对导入说明符；
 *   3. 把说明符解析成绝对路径，看它是否落在 D 里 —— 命中即为「删了运行时依赖」。
 *
 * 用法：node scripts/audit-prune-references.mjs <node_modules 根目录>
 * 退出码：发现命中即 1。
 *
 * 注意：这是**审计工具**，不是 CI 门禁（全树解析较慢，且绝对导入会走包解析，
 * 这里只做相对导入——相对导入覆盖了「同包内部被删」这一类真实事故）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { IGNORED_DIR_NAMES, containsRuntimeModule } from './prune-harness-deps.mjs';

const DEV_FILE_SUFFIXES = ['.d.ts', '.map', '.md', '.markdown'];
const DEV_FILE_NAMES = new Set(['license', 'licence', 'changelog']);

/** 该文件是否会被文件级规则删除。 */
function isDevFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return true;
  if (DEV_FILE_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (DEV_FILE_NAMES.has(lower)) return true;
  if (lower.startsWith('readme')) return true;
  return false;
}

/** 判定逻辑与 pruneNodeModules 保持一致，但只记录不删除。 */
function collectDeletions(root) {
  const deletedFiles = new Set();
  const deletedDirs = new Set();

  const scan = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(ent.name.toLowerCase()) && !containsRuntimeModule(full)) {
          deletedDirs.add(full);
        } else {
          scan(full);
        }
      } else if (ent.isFile() && isDevFile(ent.name)) {
        deletedFiles.add(full);
      }
    }
  };

  scan(root);
  return { deletedFiles, deletedDirs };
}

/** 会被 Node 在运行时加载的模块后缀。只有删掉这类文件才会导致启动失败。 */
const RUNTIME_SUFFIXES = ['.js', '.cjs', '.mjs', '.node', '.wasm', '.json'];

/**
 * 目标是否属于「删了就会炸」的运行时模块。
 *
 * 必须过滤掉 `.d.ts` / `.map` / `.md`：`import('./x.d.ts')` 这类写法大量出现在
 * JSDoc 类型注解里（如 `side-channel-list`），是**注释**而非运行时加载。
 * 不滤掉会产生上百条假阳性，把真正的命中淹没。
 */
function isRuntimeTarget(target) {
  const lower = target.toLowerCase();
  return RUNTIME_SUFFIXES.some((s) => lower.endsWith(s));
}

/** 说明符是否指向「会被删掉的路径」。 */
function hitsDeleted(target, deletedFiles, deletedDirs) {
  if (deletedFiles.has(target)) return target;
  for (const d of deletedDirs) {
    if (target === d || target.startsWith(d + '\\') || target.startsWith(d + '/')) return d;
  }
  return null;
}

const root = resolve(process.argv[2] ?? 'node_modules');
const { deletedFiles, deletedDirs } = collectDeletions(root);
console.log(`[audit] 根目录          : ${root}`);
console.log(`[audit] 将被删除的目录  : ${deletedDirs.size}`);
console.log(`[audit] 将被删除的文件  : ${deletedFiles.size}`);

const SPEC_RE = /(?:require\s*\(\s*|from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
const hits = [];
let scanned = 0;

const walk = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (deletedDirs.has(full)) continue;
      walk(full);
      continue;
    }
    if (!/\.(js|cjs|mjs)$/.test(ent.name)) continue;
    if (isDevFile(ent.name)) continue;
    scanned += 1;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1];
      const base = resolve(dirname(full), spec);
      // Node 的解析顺序：精确 → .js/.cjs/.mjs/.json → 目录下 index.*
      const candidates = [
        base,
        `${base}.js`,
        `${base}.cjs`,
        `${base}.mjs`,
        `${base}.json`,
        join(base, 'index.js'),
        join(base, 'index.cjs'),
        join(base, 'index.mjs'),
      ];
      let reported = false;
      for (const c of candidates) {
        if (!isRuntimeTarget(c)) continue;
        const where = hitsDeleted(c, deletedFiles, deletedDirs);
        if (where) {
          hits.push({ from: full, spec, target: c, deleted: where });
          reported = true;
          break;
        }
      }
      if (reported) break; // 同一文件同一说明符只报一次
    }
  }
};

walk(root);

console.log(`[audit] 扫描的存活模块  : ${scanned}`);
console.log('');
if (hits.length === 0) {
  console.log('✅ 未发现「引用了会被删除的路径」——相对导入层面闭环。');
  process.exit(0);
}
console.log(`❌ 发现 ${hits.length} 处「存活文件引用了会被删除的路径」：`);
for (const h of hits) {
  console.log('');
  console.log(`  引用方 : ${h.from.replace(root, '<root>')}`);
  console.log(`  说明符 : ${h.spec}`);
  console.log(`  解析到 : ${h.target.replace(root, '<root>')}`);
  console.log(`  被删于 : ${h.deleted.replace(root, '<root>')}`);
}
process.exit(1);
