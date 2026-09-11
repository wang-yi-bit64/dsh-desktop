#!/usr/bin/env node
/**
 * prune-harness-deps.mjs — 瘦身：从组装好的 Harness 依赖树里删掉与运行无关的文件。
 *
 * 为什么要瘦身：NSIS / dmg 需要打包和解压 node_modules，数万个小文件会显著拖慢安装。
 * 删掉 `.d.ts` / `.map` / markdown / README / LICENSE 与 `test`、`docs` 这类目录，
 * 只留核心运行时文件。
 *
 * 这里有一条**必须守住**的底线：**不能删掉运行时会被 require / import 的模块**。
 *
 * 反面教材（真实事故，2026-09-11 定位）：`IGNORED_DIRS` 里按名字收录了 `doc` / `docs`，
 * 而 `scan()` 是**递归全树**的，于是 `yaml/dist/doc/` 被当成文档目录整目录删除。
 * 那个目录里装的是 `directives.js`、`Document.js` 等**运行时模块**——`yaml` 是 Harness
 * 读配置的必需品，结果 Harness 一启动就崩：
 *
 *     Harness 出现未处理的 Promise 拒绝：Error: Cannot find module '../doc/directives.js'
 *
 * 这个缺陷能活很久，是因为**没有任何东西在运行时校验过组装后的资源树**：CI 直到
 * 2026-09-10 才加上「真实资源树 L1 烟雾」，而那条烟雾又被更早的红灯连续挡住。也就是说
 * 期间打出来的安装包都是**起不来的**，只是没人跑到那一步。
 *
 * 因此目录删除的判据不是「名字像不像开发产物」，而是**目录里有没有运行时模块**：
 * 含有可被加载的模块文件时，只递归进去删文件，绝不整目录删除。
 *
 * 用法：
 * ```bash
 * node scripts/prune-harness-deps.mjs --self-test   # 自测（含可伪证性检查）
 * ```
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 按扩展名判定为「开发产物」的文件后缀（与目录判据无关，永远删除）。 */
const IGNORED_EXTS = new Set([
  '.d.ts',
  '.d.ts.map',
  '.ts.map',
  '.js.map',
  '.mjs.map',
  '.cjs.map',
  '.md',
  '.markdown',
  '.npmignore',
  '.eslintrc',
  '.prettierrc',
  '.travis.yml',
  '.editorconfig',
]);

/**
 * 语义上属于「开发产物」的目录名（小写比较）。
 *
 * **命中这个列表只是必要条件，不是充分条件**——还必须通过 `containsRuntimeModule()`
 * 的检查。`doc` / `docs` 尤其危险：它们在某些包里是运行时路径（`yaml/dist/doc`）。
 */
export const IGNORED_DIR_NAMES = new Set([
  'test',
  'tests',
  '__tests__',
  'docs',
  'doc',
  'example',
  'examples',
  '.github',
  '.vscode',
]);

/**
 * 会被 Node 在运行时加载的模块文件后缀。
 *
 * 含 `.json`：`require('./x.json')` 是常见写法，包内数据文件也可能被读；把它算进来
 * 是刻意偏向「宁可不删」——瘦身省的是体积，误删省不下任何东西，只会得到一个起不来的包。
 */
const RUNTIME_MODULE_SUFFIXES = ['.js', '.cjs', '.mjs', '.node', '.wasm', '.json'];

/**
 * 判断目录（递归）内是否存在可被运行时加载的模块文件。
 *
 * @param {string} dir - 待检查目录的绝对路径。
 * @returns {boolean} 存在运行时模块时为 `true`（该目录不得整体删除）。
 */
export function containsRuntimeModule(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 读不到就当作「有」——不可读的目录同样不该被删。
    return true;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (containsRuntimeModule(full)) return true;
    } else if (RUNTIME_MODULE_SUFFIXES.includes(extname(ent.name).toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * 瘦身一棵依赖树（原地修改）。
 *
 * @param {string} root - 依赖树根目录（通常是 `<resources>/harness/node_modules`）。
 * @returns {{ removedDirs: number, removedFiles: number }} 删除计数，便于报告与断言。
 */
export function pruneNodeModules(root) {
  const stats = { removedDirs: 0, removedFiles: 0 };

  const scan = (currentDir) => {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const fullPath = join(currentDir, ent.name);

      if (ent.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(ent.name.toLowerCase()) && !containsRuntimeModule(fullPath)) {
          try {
            rmSync(fullPath, { recursive: true, force: true });
            stats.removedDirs += 1;
          } catch {
            /* 删不掉就留着：多占体积好过删坏 */
          }
        } else {
          // 名字命中但含运行时模块（如 `yaml/dist/doc`），或名字未命中：
          // 递归进去，文件级规则照常生效。
          scan(fullPath);
        }
        continue;
      }

      if (!ent.isFile()) continue;

      const name = ent.name.toLowerCase();
      if (
        name.endsWith('.d.ts') ||
        name.endsWith('.d.ts.map') ||
        name.endsWith('.map') ||
        name.endsWith('.md') ||
        name.endsWith('.markdown') ||
        name === 'license' ||
        name === 'licence' ||
        name === 'changelog' ||
        name.startsWith('readme') ||
        IGNORED_EXTS.has(extname(name))
      ) {
        try {
          rmSync(fullPath, { force: true });
          stats.removedFiles += 1;
        } catch {
          /* 同上 */
        }
      }
    }
  };

  scan(root);
  return stats;
}

/**
 * 自测：在临时目录里造一棵覆盖各分支的树，跑真实的 `pruneNodeModules()`。
 *
 * 第 2 组断言是**可伪证性检查**：把「旧判据」（只看目录名、不看内容）作用于同一棵
 * 树，必须复现出「`dist/doc` 被删」——证明这组断言确实抓得住那个真实事故。
 *
 * @returns {{ passed: number }} 通过项数。
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项。
 */
export function selfTest() {
  const failures = [];
  let passed = 0;
  const check = (condition, message) => {
    passed += 1;
    if (!condition) failures.push(message);
  };

  const root = mkdtempSync(join(tmpdir(), 'prune-selftest-'));
  const exists = (rel) => {
    try {
      statSync(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };
  const put = (rel) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '// fixture\n', 'utf8');
  };

  try {
    // 真实形态照搬：yaml 这类包的运行时模块就藏在 dist/doc/ 下。
    put('demo/package.json');
    put('demo/dist/index.js');
    put('demo/dist/doc/directives.js');
    put('demo/dist/doc/notes.md');
    put('demo/docs/guide.md');
    put('demo/docs/assets/logo.png');
    put('demo/test/spec.js');
    put('demo/test/spec.js.map');
    put('demo/__tests__/only.md');
    put('demo/index.d.ts');
    put('demo/README.md');

    // 1) 内容判据：含运行时模块的 doc 目录必须幸存，其中的 .md 仍被删。
    pruneNodeModules(root);
    check(exists('demo/dist/doc/directives.js'), '瘦身：dist/doc/ 下的运行时模块被删了（真实事故的回归钉）');
    check(!exists('demo/dist/doc/notes.md'), '瘦身：dist/doc/ 下的 .md 未被删除');
    check(exists('demo/dist/index.js'), '瘦身：dist/index.js 被删了');

    // 2) 纯开发产物的目录仍要整体删除，瘦身不能因为新判据失效。
    check(!exists('demo/docs'), '瘦身：只有 .md 的 docs/ 目录未被整体删除');
    check(!exists('demo/__tests__'), '瘦身：只有 .md 的 __tests__/ 目录未被整体删除');
    check(!exists('demo/index.d.ts'), '瘦身：.d.ts 未被删除');
    check(!exists('demo/README.md'), '瘦身：README.md 未被删除');

    // 3) 名字命中但含运行时模块的 test/：目录保留，但目录内的 .map 仍要删。
    check(exists('demo/test/spec.js'), '瘦身：含运行时模块的 test/ 目录被整体删除了');
    check(!exists('demo/test/spec.js.map'), '瘦身：test/ 内的 .map 未被删除');

    // 4) package.json 必须留（运行时读得到）。
    check(exists('demo/package.json'), '瘦身：package.json 被删了');

    // 5) 可伪证性：旧判据（只看名字）作用于同一棵树时，必须复现出事故形态。
    const bug = mkdtempSync(join(tmpdir(), 'prune-bugcheck-'));
    try {
      const oldRuleDelete = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (IGNORED_DIR_NAMES.has(ent.name.toLowerCase())) rmSync(full, { recursive: true, force: true });
            else oldRuleDelete(full);
          }
        }
      };
      mkdirSync(join(bug, 'demo/dist/doc'), { recursive: true });
      writeFileSync(join(bug, 'demo/dist/doc/directives.js'), '// fixture\n', 'utf8');
      oldRuleDelete(bug);
      const survived = (() => {
        try {
          statSync(join(bug, 'demo/dist/doc/directives.js'));
          return true;
        } catch {
          return false;
        }
      })();
      check(!survived, '瘦身：可伪证性检查失败——旧判据应当删掉 dist/doc，断言才有意义');
    } finally {
      rmSync(bug, { recursive: true, force: true });
    }

    if (failures.length > 0) {
      throw new Error(`prune 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
    }
    return { passed };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结论 */
    }
  }
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ prune 自测通过（${passed} 项）`);
  } else {
    console.log('用法：node scripts/prune-harness-deps.mjs --self-test');
    console.log(`被 prepare-harness.mjs 引用：pruneNodeModules(<resources>/harness/node_modules)`);
    process.exit(1);
  }
}
