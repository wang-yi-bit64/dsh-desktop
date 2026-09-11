#!/usr/bin/env node
/**
 * verify-harness-tree.mjs — 组装后的 Harness 依赖树**健全性**检查。
 *
 * 为什么需要它：`node_modules` 可以**静默地**不完整，而后果要等到用户启动才出现。
 * 已知的两条真实路径：
 *
 *   1. **解包失败只报 warn。** npm/tar 遇到 `EPERM` / `EEXIST` 只会打一条
 *      `npm warn tar TAR_ENTRY_ERROR …`，安装整体仍算成功。包于是**缺文件**，
 *      而 `package.json` / 入口文件都在——看起来完全正常。
 *      （本机实测：`yaml/dist/doc/anchors.js` 与 `zod` 的 `v3`/`v4`/`v4-mini`
 *      共 482 个文件因此缺失。）
 *   2. **瘦身判据误删。** 见 `prune-harness-deps.mjs` 头部记录的 `yaml/dist/doc` 事故。
 *
 * 两种情况的共同点：`tauri build` 成功、安装包能装、签名能过，只有 Harness 启动时
 * 报 `Cannot find module …`。**没有任何静态检查看得见。**
 *
 * 这个脚本补上那一环：把「被引用的路径是否存在」显式算一遍。
 *
 *   - 每个 `.js` / `.cjs` / `.mjs` 里的**相对**导入说明符都必须能解析到磁盘上的文件；
 *   - 每个 `package.json` 的 `main` / `exports` / `bin`（`./` 开头的目标）都必须存在。
 *
 * 用法：
 * ```bash
 * node scripts/verify-harness-tree.mjs <node_modules 根目录>
 * node scripts/verify-harness-tree.mjs --self-test
 * ```
 * 退出码：0 全通过；1 有缺失（打印按包分组的清单）。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Node 解析相对说明符时按序尝试的补全。 */
const RESOLVE_SUFFIXES = ['.js', '.cjs', '.mjs', '.json', '.node', '.wasm'];
/** 目录形式的导入会落到这些入口。 */
const INDEX_NAMES = ['index.js', 'index.cjs', 'index.mjs', 'index.json'];

/**
 * 收集文件里的导入说明符（含裸包名）。
 *
 * 先剥掉注释：`import('./x.d.ts')` 大量出现在 JSDoc 类型注解里（如
 * `side-channel-list`），那是**注释**不是加载。不剥会引入成片假阳性。
 * 剥注释用的是轻量扫描而非完整词法分析——它只需保证「不把字符串里的 `//`
 * 当成注释」，对本用途足够。
 *
 * @param {string} source 模块源码。
 * @returns {{relative: string[], bare: string[]}} 相对/绝对说明符与裸包说明符。
 */
export function extractSpecifiers(source) {
  const relative = [];
  const bare = [];
  const pattern = /(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  let inBlock = false;
  for (const rawLine of source.split(/\r?\n/)) {
    let out = '';
    for (let i = 0; i < rawLine.length; i += 1) {
      if (inBlock) {
        if (rawLine[i] === '*' && rawLine[i + 1] === '/') {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (rawLine[i] === '/' && rawLine[i + 1] === '*') {
        inBlock = true;
        i += 1;
        continue;
      }
      // 行注释：要求 `//` 前面不是 `:`（避免把 `https://` 当注释）。
      if (rawLine[i] === '/' && rawLine[i + 1] === '/' && rawLine[i - 1] !== ':') break;
      out += rawLine[i];
    }
    for (const match of out.matchAll(pattern)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('/')) relative.push(spec);
      // `node:` 是内置模块；`file:`/URL 形态不按包解析。
      else if (!spec.startsWith('node:') && !/^[a-z]+:/i.test(spec)) bare.push(spec);
    }
  }
  return { relative, bare };
}

/**
 * 从裸说明符里取包名：`@scope/pkg/sub/path` → `@scope/pkg`，`pkg/sub` → `pkg`。
 * @param {string} specifier 裸说明符。
 * @returns {string} 包名。
 */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * 从 `fromFile` 出发向上逐级查找 `node_modules/<包名>`（Node 的解析算法）。
 *
 * **必须先取 `fromFile` 的真实路径**：`file:` 依赖在 `node_modules` 里是符号链接，
 * Node 会按**链接目标**所在目录向上解析。不取真实路径，这个函数就会认为插件的
 * 依赖能在 `node_modules` 下找到，从而漏掉真实事故
 * （`vendor/<pkg>/index.js` 里 `import 'fflate'` 解析失败）。
 *
 * @param {string} fromFile 引用方文件绝对路径。
 * @param {string} packageName 裸包名。
 * @returns {boolean} 能找到该包时为 `true`。
 */
export function resolvesBarePackage(fromFile, packageName) {
  let dir = dirname(realpathOf(fromFile));
  for (;;) {
    if (existsSync(join(dir, 'node_modules', packageName))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * 取真实路径；失败时回退到原路径（路径不存在等情况不该让检查器崩溃）。
 * @param {string} path 任意路径。
 * @returns {string} 真实路径或原路径。
 */
function realpathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 解析一个相对说明符是否指向磁盘上真实存在的东西。
 *
 * 与 Node 的解析顺序一致：精确 → 补后缀 → 目录下的 index.*。
 * `specifier` 若是目录（如 `./foo`，且 `./foo/package.json` 存在），也算解析成功。
 *
 * @param {string} fromFile 引用方文件的绝对路径。
 * @param {string} specifier 相对说明符。
 * @returns {boolean} 能解析到真实文件/目录时为 `true`。
 */
export function resolvesOnDisk(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base)) {
    try {
      if (!statSync(base).isDirectory()) return true;
      // 是目录：必须能落到 index.* 或 package.json 的入口才算可用。
      for (const name of INDEX_NAMES) if (existsSync(join(base, name))) return true;
      return existsSync(join(base, 'package.json'));
    } catch {
      return true;
    }
  }
  for (const suffix of RESOLVE_SUFFIXES) if (existsSync(base + suffix)) return true;
  for (const name of INDEX_NAMES) if (existsSync(join(base, name))) return true;
  return false;
}

/**
 * 从 package.json 里抽出必须存在的入口目标（`./` 开头）。
 * @param {object} manifest 已解析的 package.json。
 * @returns {Array<[string, string]>} `[字段路径, 目标]` 列表。
 */
export function manifestTargets(manifest) {
  const targets = [];
  for (const field of ['main', 'module', 'types']) {
    if (typeof manifest[field] === 'string' && manifest[field].startsWith('./')) {
      targets.push([field, manifest[field]]);
    }
  }
  if (typeof manifest.bin === 'string' && manifest.bin.startsWith('./')) targets.push(['bin', manifest.bin]);
  else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const [name, value] of Object.entries(manifest.bin)) {
      if (typeof value === 'string' && value.startsWith('./')) targets.push([`bin.${name}`, value]);
    }
  }
  const walkExports = (value, key) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push([key, value]);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walkExports(v, `${key}.${k}`);
    }
  };
  if (manifest.exports) walkExports(manifest.exports, 'exports');
  return targets;
}

/**
 * 规则 1：树内不得存在**逃出树外**的符号链接。
 *
 * 为什么这条是精确的：`file:` 依赖在 `node_modules` 里是符号链接（npm 的正常行为），
 * 而 `prepare-harness` 把树复制进 `resources/` 时，若不解引用，复制出来的是
 * **指向开发机绝对路径**的链接——打包后目标不存在，插件必然加载失败。
 *
 * 同时，链接逃出树外意味着插件自身的裸导入会按链接目标的真实路径向上解析，
 * 那里没有 `node_modules`，于是 `Cannot find package '<dep>'`（真实事故）。
 *
 * 只检查 `node_modules` 下的**直接条目**与 `@scope/<name>`：那是 npm 建链接的位置；
 * 深层链接多为构建产物，不在本规则范围。
 *
 * @param {string} root `node_modules` 根目录。
 * @returns {Array<{entry: string, target: string}>} 逃出树外的链接。
 */
export function verifyNoEscapingLinks(root) {
  const escaping = [];
  const realRoot = realpathOf(root);
  const candidates = [];
  for (const name of readdirSafe(root)) {
    if (name === '.bin' || name.startsWith('.')) continue;
    candidates.push([name, join(root, name)]);
    if (name.startsWith('@')) {
      for (const sub of readdirSafe(join(root, name))) candidates.push([`${name}/${sub}`, join(root, name, sub)]);
    }
  }
  for (const [label, full] of candidates) {
    let isLink = false;
    try {
      isLink = lstatSync(full).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    const target = realpathOf(full);
    if (target !== realRoot && !target.startsWith(realRoot + sep)) {
      escaping.push({ entry: label, target });
    }
  }
  return escaping;
}

/**
 * 规则 2：桌面插件（`dsh-desktop-*`）的**启动入口**里，裸导入必须能在树内解析。
 *
 * 为什么只查入口、且沿相对导入传递：Cordis loader 启动一个插件时 import 的是
 * `package.json` 的 `main` / `exports['.']`（CI 报错正是 `failed to import loader
 * entry <name>`）。入口沿相对导入触达的文件也在启动路径上，一并检查。
 *
 * 为什么**不**查包里的其它文件：`client.js` 这类文件由 Harness 的客户端模块
 * 体系（另一套加载机制）处理，不走 Node 的解析算法，按 Node 规则判定只会产生
 * 误报（实测：`dsh-desktop-client-ui/client.js` import 的
 * `@deepseek-ai/dsh-client-ui-primitives` 树内根本没有，但启动完全正常）。
 *
 * @param {string} root `node_modules` 根目录。
 * @param {string} prefix 包名前缀。
 * @returns {Array<{pkg: string, file: string, details: string[]}>} 无法解析的裸导入。
 */
export function verifyPluginBareImports(root, prefix = 'dsh-desktop-') {
  const problems = [];
  for (const name of readdirSafe(root)) {
    if (!name.startsWith(prefix)) continue;
    const pkgDir = join(root, name);
    if (!isDirectory(pkgDir)) continue;

    const manifestPath = join(pkgDir, 'package.json');
    let entry;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      entry = typeof manifest.main === 'string' ? manifest.main : './index.js';
    } catch {
      entry = './index.js';
    }
    const entryAbs = resolve(pkgDir, entry);
    if (!existsSync(entryAbs)) {
      problems.push({ pkg: name, file: manifestPath, details: [`入口不存在: ${entry}`] });
      continue;
    }

    // 从入口出发，沿**相对**导入收集启动闭包（只在包目录内，避免跑出包外）。
    const seen = new Set();
    const queue = [entryAbs];
    const closure = [];
    while (queue.length > 0) {
      const file = queue.pop();
      const key = realpathOf(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      closure.push(file);
      const { relative } = extractSpecifiers(source);
      for (const spec of relative) {
        const base = resolve(dirname(file), spec);
        for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.cjs'), join(base, 'index.mjs')]) {
          if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
            // 只在包目录内追踪，避免把整个依赖树拖进来。
            if (candidate.toLowerCase().startsWith(pkgDir.toLowerCase())) queue.push(candidate);
            break;
          }
        }
      }
    }

    for (const file of closure) {
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const details = [...new Set(extractSpecifiers(source).bare.map(packageNameOf))].filter(
        (spec) => !resolvesBarePackage(file, spec)
      );
      if (details.length > 0) problems.push({ pkg: name, file, details });
    }
  }
  return problems;
}

/** 目录存在性判断（跟随符号链接）。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 递归复制（自测夹具用）。 */
function cpDir(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

/** readdirSync 的容错版本，返回名称数组。 */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 检查一棵依赖树。
 *
 * @param {string} root 根目录（通常是 `<resources>/harness/node_modules`）。
 * @returns {{scannedFiles: number, scannedManifests: number, missing: Array<{file: string, details: string[]}>}}
 */
export function verifyTree(root) {
  const missing = [];
  let scannedFiles = 0;
  let scannedManifests = 0;
  /** 已访问过的真实目录，防符号链接成环时无限递归。 */
  const visited = new Set();

  const walk = (dir) => {
    const real = realpathOf(dir);
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      if (isLink) {
        // **必须跟随符号链接**：`file:` 依赖在 node_modules 里就是链接。
        // 跳过它们等于让这条门禁看不见本次要抓的真实事故
        // （链接指向 vendor/<pkg>，其裸依赖解析不到）。
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false; // 死链接：跳过（另有检查负责别的路径）
        }
      }
      if (isDir) {
        walk(full);
        continue;
      }
      if (!entry.isFile() && !isLink) continue;

      if (entry.name === 'package.json') {
        scannedManifests += 1;
        let manifest;
        try {
          manifest = JSON.parse(readFileSync(full, 'utf8'));
        } catch {
          continue; // 解析不了不是本门禁的职责
        }
        const details = [];
        for (const [field, target] of manifestTargets(manifest)) {
          const abs = resolve(dirname(full), target);
          if (!existsSync(abs)) details.push(`${field} → ${target}`);
        }
        if (details.length > 0) missing.push({ file: full, details });
        continue;
      }

      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      scannedFiles += 1;
      let source;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const details = [];
      const { relative, bare } = extractSpecifiers(source);
      for (const spec of new Set(relative)) {
        if (!resolvesOnDisk(full, spec)) details.push(`import ${spec}`);
      }
      for (const spec of new Set(bare.map(packageNameOf))) {
        if (!resolvesBarePackage(full, spec)) details.push(`import ${spec}（裸包）`);
      }
      if (details.length > 0) missing.push({ file: full, details });
    }
  };

  walk(root);
  return { scannedFiles, scannedManifests, missing };
}

/**
 * 自测：临时树里造「存在」与「缺失」两类引用，断言只报后者。
 *
 * 第 2 组是**可伪证性检查**：把缺失文件补上，全部断言必须转为通过——
 * 否则说明这个检查器只会无脑报错。
 *
 * @returns {{passed: number}}
 */
export function selfTest() {
  const failures = [];
  let passed = 0;
  const check = (condition, message) => {
    passed += 1;
    if (!condition) failures.push(message);
  };

  // 拓扑必须与真实仓库一致：`vendor/` 与 `node_modules/` 是**兄弟**，不是上下级。
  // 链接目标放在树外的另一个分支下，向上查找才**不会**命中树内的 node_modules
  // ——这正是 `file:` 依赖解析失败的机制。
  const base = mkdtempSync(join(tmpdir(), 'verify-tree-'));
  const root = join(base, 'tree');
  const outside = join(base, 'vendor', 'plugin');
  mkdirSync(root, { recursive: true });
  const put = (rel, content = '// fixture\n') => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  const putOutside = (rel, content = '// fixture\n') => {
    const full = join(outside, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  try {
    put('pkg/package.json', JSON.stringify({ name: 'pkg', main: './index.js' }));
    put('pkg/index.js', "require('./ok.js');\nimport('./missing.js');\n");
    put('pkg/ok.js');
    put('broken/package.json', JSON.stringify({ name: 'broken', main: './gone.js' }));
    put('broken/index.js', 'export {}\n');

    // 裸包解析：树内的包能解析；被链接到树外的包解析不到（真实事故形态）。
    put('node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: './index.js' }));
    put('node_modules/dep/index.js', 'export {}\n');
    put('node_modules/good-plugin/index.js', "import 'dep'\n");
    putOutside('index.js', "import 'dep'\n");
    symlinkSync(outside, join(root, 'node_modules', 'linked-plugin'), 'junction');

    let result = verifyTree(root);
    const brokenFiles = result.missing.map((m) => m.file.replace(/\\/g, '/'));
    check(
      brokenFiles.some((f) => f.endsWith('pkg/index.js')),
      '健全性：pkg/index.js 引用了不存在的 ./missing.js，未被报出'
    );
    check(
      brokenFiles.some((f) => f.endsWith('broken/package.json')),
      '健全性：broken 的 main 指向不存在的 ./gone.js，未被报出'
    );
    check(
      !brokenFiles.some((f) => f.endsWith('pkg/ok.js')),
      '健全性：存在且解析正常的文件被误报'
    );
    check(
      brokenFiles.some((f) => f.endsWith('node_modules/linked-plugin/index.js')),
      '健全性：指向树外的符号链接插件（裸依赖解析不到）未被报出——正是真实事故的形态'
    );
    check(
      !brokenFiles.some((f) => f.includes('good-plugin')),
      '健全性：树内的插件能解析自己的裸依赖，却被误报'
    );

    // 可伪证性：把全部缺陷消掉，必须转为全通过。
    //   · 补上缺失的相对导入目标；
    //   · 修复符号链接插件 —— 注意**不能**靠删掉链接来「修复」，
    //     那只会让检查器看不见它。正确做法是在**链接目标的祖先目录**里
    //     放上依赖，证明这个检查器确实按真实路径（realpath）解析。
    put('pkg/missing.js');
    put('broken/gone.js');
    mkdirSync(join(base, 'vendor', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(
      join(base, 'vendor', 'node_modules', 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', main: './index.js' }),
      'utf8'
    );
    writeFileSync(join(base, 'vendor', 'node_modules', 'dep', 'index.js'), 'export {}\n', 'utf8');
    result = verifyTree(root);
    check(
      result.missing.length === 0,
      `可伪证性：消除全部缺陷后仍报 ${result.missing.length} 处（${result.missing
        .map((m) => m.file.replace(root, '.'))
        .slice(0, 5)
        .join(', ')}），检查器不可信`
    );
    check(
      result.scannedFiles >= 5,
      `健全性：扫描到的模块数偏少（${result.scannedFiles}），可能未跟随符号链接`
    );

    // --- 规则 1：逃出树外的符号链接 ---
    // 此时 linked-plugin 仍是链接（目标在 base/vendor/plugin），必须被判为逃逸；
    // 而 root 内没有其它链接。
    const escaping = verifyNoEscapingLinks(join(root, 'node_modules'));
    check(
      escaping.some((e) => e.entry === 'linked-plugin'),
      '规则1：逃出树外的符号链接未被报出'
    );
    check(escaping.length === 1, `规则1：误报 ${escaping.length - 1} 处`);
    // 可伪证性：把链接换成真实目录（＝实体化），必须转为通过。
    mkdirSync(join(base, 'real-plugin'), { recursive: true });
    writeFileSync(join(base, 'real-plugin', 'index.js'), 'export {}\n', 'utf8');
    rmSync(join(root, 'node_modules', 'linked-plugin'), { force: true });
    cpDir(join(base, 'real-plugin'), join(root, 'node_modules', 'linked-plugin'));
    check(
      verifyNoEscapingLinks(join(root, 'node_modules')).length === 0,
      '规则1 可伪证性：把链接实体化后仍被报出，规则不可信'
    );

    // --- 规则 2：桌面插件的裸导入 ---
    cpDir(join(root, 'node_modules', 'good-plugin'), join(root, 'node_modules', 'dsh-desktop-good'));
    cpDir(join(root, 'node_modules', 'linked-plugin'), join(root, 'node_modules', 'dsh-desktop-bad'));
    rmSync(join(root, 'node_modules', 'dsh-desktop-bad', 'index.js'), { force: true });
    writeFileSync(join(root, 'node_modules', 'dsh-desktop-bad', 'index.js'), "import 'absent-dep'\n", 'utf8');
    // 入口闭包**之外**的文件（如 client.js）由客户端模块体系加载，不在启动路径上，
    // 它的裸导入不应被这条规则报出——否则会把客户端依赖误当启动故障。
    writeFileSync(
      join(root, 'node_modules', 'dsh-desktop-good', 'client.js'),
      "import 'absent-client-dep'\n",
      'utf8'
    );
    const pluginProblems = verifyPluginBareImports(join(root, 'node_modules'));
    check(
      pluginProblems.some((p) => p.pkg === 'dsh-desktop-bad' && p.details.includes('absent-dep')),
      '规则2：桌面插件入口无法解析的裸依赖未被报出'
    );
    check(
      !pluginProblems.some((p) => p.pkg === 'dsh-desktop-good'),
      '规则2：能解析裸依赖的桌面插件被误报（client.js 等非入口文件不应被扫）'
    );

    if (failures.length > 0) throw new Error(`verify-harness-tree 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
    return { passed };
  } finally {
    try {
      // 先删链接本身，避免递归删除跟随到 base 之外。
      try {
        if (lstatSync(join(root, 'node_modules', 'linked-plugin')).isSymbolicLink()) {
          rmSync(join(root, 'node_modules', 'linked-plugin'), { force: true });
        }
      } catch {
        /* 链接不存在 */
      }
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

const isDirectRun = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ verify-harness-tree 自测通过（${passed} 项）`);
  } else {
    const root = process.argv[2];
    if (!root) {
      console.error('用法：node scripts/verify-harness-tree.mjs <node_modules 根目录> [--full]');
      console.error('      node scripts/verify-harness-tree.mjs --self-test');
      console.error('');
      console.error('默认只跑两条**零噪声**规则（作为门禁）：');
      console.error('  规则1 树内不得存在逃出树外的符号链接（file: 依赖未实体化）');
      console.error('  规则2 dsh-desktop-* 插件的裸导入必须能在树内解析');
      console.error('--full 追加全树存在性扫描（**仅供诊断**：会被 benchmark/test/可选');
      console.error('       路径/exports 通配条件淹掉，实测 351 个包、1520 处命中，不能当门禁）');
      process.exit(2);
    }
    const resolved = resolve(root);
    const failing = [];

    console.log(`[tree] 根目录: ${resolved}`);

    const escaping = verifyNoEscapingLinks(resolved);
    if (escaping.length === 0) {
      console.log('✅ 规则1：没有逃出树外的符号链接。');
    } else {
      console.log(`❌ 规则1：${escaping.length} 个符号链接指向树外——复制进安装包后会变成死链接，`);
      console.log('        且插件的裸导入会按链接目标的真实路径解析而找不到依赖：');
      for (const item of escaping) console.log(`    ${item.entry}  →  ${item.target}`);
      failing.push('规则1');
    }

    const plugins = verifyPluginBareImports(resolved);
    if (plugins.length === 0) {
      console.log('✅ 规则2：桌面插件的裸导入全部可在树内解析。');
    } else {
      console.log(`❌ 规则2：${plugins.length} 个桌面插件文件存在无法解析的裸导入：`);
      for (const item of plugins.slice(0, 20)) {
        console.log(`    ${item.pkg}: ${item.file.replace(resolved, '<root>')}`);
        console.log(`        · ${item.details.join(', ')}`);
      }
      failing.push('规则2');
    }

    if (process.argv.includes('--full')) {
      const { scannedFiles, scannedManifests, missing } = verifyTree(resolved);
      console.log('');
      console.log(`[tree] --full 诊断：模块 ${scannedFiles} / package.json ${scannedManifests} / 命中 ${missing.length}`);
      for (const item of missing.slice(0, 15)) {
        console.log(`    ${item.file.replace(resolved, '<root>')}  →  ${item.details.slice(0, 3).join('; ')}`);
      }
      if (missing.length > 15) console.log(`    …另有 ${missing.length - 15} 个文件`);
      console.log('    （以上仅供诊断，不影响退出码）');
    }

    process.exit(failing.length === 0 ? 0 : 1);
  }
}
