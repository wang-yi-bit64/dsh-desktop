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
 * 另有一条**声明面**规则（规则 3），治的是另一类「装得上、起不来」——这一次不是缺文件，
 * 而是**声明说谎**：上游自 0.2.0 起有一道 peer 门禁
 * （`dsh-app-boot` 的 `evaluatePluginCompatibility()`），它把插件 `package.json` 里
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 区间拿去和**当前运行时版本**做
 * `semver.satisfies(…, { includePrerelease: true })`。不满足的：profile bundle 被
 * `skipping profile bundle`（不加载），普通插件行被 `disabling profile plugin row`（不启用）。
 * 两者都**只在 stderr 打一行**，退出码仍是 0——用户看到的是「插件页显示已安装却用不了」。
 *
 * 本仓的 vendored 包（`vendor/*`）正是受害者：它们的 peer 区间写的是**当时的**运行时线
 * （`^0.1.2-alpha.4`），上游一跨 minor 就全部失配，而 `vendor/**` 不在任何门禁的扫描面里，
 * 于是一路静默。规则 3 就是补上这个扫描面，判据三条：
 *
 *   - **3a 相容**：每个 `dsh-*` peer 区间必须被**每个在役目标**的 `dshVersion` 满足；
 *   - **3b 一致**：树内已安装的同一包，其 `dsh-*` 区间必须与 `vendor/` 源**逐字相同**
 *     （防「改了源、发的还是旧拷贝」——`src-tauri/resources/` 是 gitignore 的构建产物）；
 *   - **3c 不过宽**：区间必须**拒绝**「最高在役目标的下一个 minor」的预发布
 *     （如 `0.3.0-rc.1`）。少了这条，把区间写成 `*` 也能全绿——那样门禁就成了摆设。
 *   - **3d 三面对齐**：提交式 lockfile（`harness-locks/<target>/`）里抄录的该包
 *     `version` / `peerDependencies` 必须与 `vendor/` 源一致。它是**第三个声明面**：
 *     源、装配树、lockfile。少了这条，修好源与树之后 lock 仍在散播旧声明，
 *     而 `lockInputsMatch` 的四条规则看不见这一份。
 *
 * 🔴 比较器**不自己写**：判据要回答的问题是「**上游的 semver** 会不会拒绝」，
 * 因此 `satisfies` 从**被测树自己**解析（与运行时同源）。本仓已有两套版本比较器
 * （Rust `Ord` 含 build、JS 忽略 build），再添第三套就是第三个分歧面。
 * 树里取不到 semver 时**判红**，因为「判不了」不等于「通过」。
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
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DSH_TARGETS, parseVersionShape } from './dsh-targets.mjs';

/** Node 解析相对说明符时按序尝试的补全。 */
const RESOLVE_SUFFIXES = ['.js', '.cjs', '.mjs', '.json', '.node', '.wasm'];
/** 目录形式的导入会落到这些入口。 */
const INDEX_NAMES = ['index.js', 'index.cjs', 'index.mjs', 'index.json'];
/** 本仓根目录（`scripts/` 的上一级）——`vendor/` 的默认位置由它推导，清单不写死。 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

//#region 规则 3：vendored 包的 dsh-* peer 区间（上游 0.2.0 起的 peer 门禁）

/**
 * 上游 `evaluatePluginCompatibility()` 里的三条 `workspace:` 特例。
 *
 * 上游把它们替换成**当前运行时版本**再判——即「我就是要这个 runtime」。
 * 本仓**不能**用它们：vendored 包是 `file:` 依赖，npm 对 `file:` 依赖的
 * `peerDependencies` 里的 `workspace:` 直接报
 * `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:": workspace:*`（实测）。
 */
const WORKSPACE_RANGES = ['workspace:^', 'workspace:~', 'workspace:*'];

/**
 * 该 peer 名是否会进上游门禁。
 *
 * 与上游第 294 行的过滤条件**逐字同构**：`@deepseek-ai/dsh` 本身，以及
 * `@deepseek-ai/dsh-` 前缀。放宽会漏，收紧会误报——两者都会让本条门禁与
 * 运行时的真实行为脱节，而这条门禁的**唯一价值**就是复现那个行为。
 *
 * @param {string} name peer 名。
 * @returns {boolean} 属于 dsh 家族时为 `true`。
 */
export function isDshPeerName(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
}

/**
 * 从 manifest 里取出会进上游门禁的 `[peer 名, 区间]` 列表。
 * @param {object} manifest 已解析的 package.json。
 * @returns {Array<[string, unknown]>} `dsh-*` peer（区间原样返回，非法值交给判定器判红）。
 */
export function dshPeerRangesOf(manifest) {
  const peers = manifest === null || typeof manifest !== 'object' ? undefined : manifest.peerDependencies;
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return [];
  return Object.entries(peers).filter(([name]) => isDshPeerName(name));
}

/**
 * 复刻上游判定式。**比较器由调用方注入**，不在本文件里自造。
 *
 * 上游原式（`dsh-app-boot/lib/index.js:292-301`）：
 * ```js
 * const requirement = ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range;
 * if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, {includePrerelease:true})) peers[name] = range;
 * ```
 * 三条细节都必须留着，否则结论会偏：
 *   · `includePrerelease: true` —— 上游的版本一律是预发布（`0.2.0-rc.2`）；
 *   · 非字符串区间上游**抛错**（`must be a string`）⇒ 这里判为「不相容」，因为
 *     抛错同样走不到「加载成功」；
 *   · 区间非法时 `semver.satisfies` 返回 `false`（不抛），这里也按不相容处理。
 *
 * @param {(runtimeVersion: string, range: string, options: object) => boolean} satisfies 真实 semver 的 `satisfies`。
 * @param {string} runtimeVersion 运行时版本（目标的 `dshVersion`）。
 * @param {unknown} range 声明的 peer 区间。
 * @returns {boolean} 上游会判为「相容」时为 `true`。
 */
export function dshPeerSatisfied(satisfies, runtimeVersion, range) {
  if (typeof range !== 'string') return false;
  const requirement = WORKSPACE_RANGES.includes(range) ? runtimeVersion : range;
  if (requirement.trim() === '') return false;
  try {
    return satisfies(runtimeVersion, requirement, { includePrerelease: true }) === true;
  } catch {
    return false;
  }
}

/**
 * 3c 的探针版本：**最高在役目标的下一个 minor** 的预发布。
 *
 * 例如在役目标是 `0.2.0-rc.2` 与 `0.2.1-alpha.1` ⇒ 探针 `0.3.0-rc.1`。
 * 为什么用「下一个 minor 的**预发布**」而不是 `0.3.0`：区间若写成 `<0.3.0`
 * （少了 `-0`），`0.3.0-rc.1` 会**被接受**而 `0.3.0` 不会——只探 `0.3.0`
 * 就看不见这个缺口。上游的 caret 会把它展开成 `<0.3.0-0`（这正是我们踩过的坑：
 * `^0.1.2-alpha.4` 的上界是 `<0.2.0-0`，因此 `0.2.0-rc.2` **不**满足它）。
 *
 * @param {string[]} versions 在役目标的 `dshVersion` 列表。
 * @returns {{core: string, probe: string}|null} `core` 是下一个 minor 的零补丁版本
 *   （如 `0.3.0`），`probe` 是它的预发布（`0.3.0-rc.1`）；全部无法解析时为 `null`。
 */
export function nextMinorProbe(versions) {
  const shapes = versions.map((version) => parseVersionShape(version)).filter((shape) => shape.ok);
  if (shapes.length === 0) return null;
  const top = shapes.reduce((a, b) => {
    if (b.major !== a.major) return b.major > a.major ? b : a;
    return b.minor > a.minor ? b : a;
  });
  const core = `${top.major}.${top.minor + 1}.0`;
  return { core, probe: `${core}-rc.1` };
}

/**
 * 从**被测树自己**解析 semver。
 *
 * 为什么不在本文件 `import 'semver'`：本仓 `scripts/**` 刻意只用 `node:` 内置模块
 * （全仓 grep `^import .* from '[a-z@]` 无命中），加一个第三方依赖会给「跑门禁」
 * 添一次 `npm install` 前置条件。而真正要复现的是**运行时那个 semver**，
 * 它就在被测树里（`dsh-app-boot` 依赖它）——从那里取，与运行时同源。
 *
 * @param {string} root 被测树的 `node_modules` 根目录。
 * @returns {{satisfies: Function, version: string}|null} 取不到时为 `null`（调用方必须判红）。
 */
export function loadSemverFromTree(root) {
  try {
    const require = createRequire(join(resolve(root), 'x.js'));
    const semver = require('semver');
    if (semver === null || typeof semver?.satisfies !== 'function') return null;
    let version = 'unknown';
    try {
      version = require('semver/package.json').version;
    } catch {
      /* 版本号只用于打印，取不到不影响判定 */
    }
    return { satisfies: (runtime, range, options) => semver.satisfies(runtime, range, options), version };
  } catch {
    return null;
  }
}

/**
 * 规则 3：vendored 包的 `dsh-*` peer 区间必须与在役运行时相容、与源一致、且不过宽。
 *
 * 包名单**不写死**：从 `vendorDir` 下**发现**（本仓的 vendored 包全在那里）。
 * 目标也不写死：来自 `dsh-targets.mjs`。判据因此在没有人工维护的前提下跟着两者走。
 *
 * 休眠目标（ADR-056）只打印、不判——「不发布、不追漂移」是已裁定的语义；
 * 但**打印**是必须的，否则「跳过」与「通过」在输出里同形。
 *
 * @param {string} root 被测树的 `node_modules` 根目录（3b 用）。
 * @param {object} [options] 可选项。
 * @param {string} [options.vendorDir] `vendor/` 目录；默认本仓。
 * @param {string} [options.lockDir] `harness-locks/` 目录（3d 用）；默认本仓。
 * @param {Array<{name: string, status: string, dshVersion: string}>} [options.targets] 目标表；默认 `DSH_TARGETS`。
 * @param {Function} [options.satisfies] 比较器（真实 semver 的 `satisfies`）。缺失时判红。
 * @returns {{problems: Array<object>, notes: string[], control: object|null,
 *   checked: {packages: number, peers: number, activeTargets: number}, dormant: string[],
 *   blocked: string[]}} 判定结果；`blocked` 非空表示**判不了**（调用方必须判红）。
 */
export function verifyVendorPeerRanges(root, options = {}) {
  const vendorDir = options.vendorDir ?? join(projectRoot, 'vendor');
  const lockDir = options.lockDir ?? join(projectRoot, 'harness-locks');
  const satisfies = options.satisfies ?? null;
  const targets =
    options.targets ??
    Object.entries(DSH_TARGETS).map(([name, target]) => ({ name, ...target }));
  const active = targets.filter((target) => target.status === 'active');
  const dormant = targets.filter((target) => target.status !== 'active').map((target) => target.name);

  const problems = [];
  const notes = [];
  const checked = { packages: 0, peers: 0, activeTargets: active.length };
  const blocked = [];

  if (satisfies === null) blocked.push('树内取不到 semver —— 判不了的不得算通过');
  if (active.length === 0) blocked.push('没有在役目标 —— 没有任何判据被执行（空集不得冒充通过）');
  if (blocked.length > 0) return { problems, notes, control: null, checked, dormant, blocked };

  const next = nextMinorProbe(active.map((target) => target.dshVersion));
  if (next === null) {
    blocked.push('在役目标的 dshVersion 无法解析 —— 算不出 3c 探针');
    return { problems, notes, control: null, checked, dormant, blocked };
  }
  const { core: nextCore, probe } = next;

  // 判据自身的正控/负控：用**每个在役目标各自的规范区间**验一次比较器。
  // 为什么不挑「最低/最高」目标：那需要版本排序，而排序正是比较器本身——
  // 用一个待验的比较器去选比较对象，控制就失去意义。这里逐目标构造，与顺序无关。
  //   正控：目标的运行时必须满足「>=它自己 <下一个 minor 的 -0」（不成立 ⇒ 比较器或目标表失真）
  //   负控：探针必须**不**满足同一个上界（不成立 ⇒ 3c 形同虚设，`*` 也能全绿）
  const control = {
    probe,
    nextCore,
    range: `>=${active[0].dshVersion} <${nextCore}-0`,
    acceptsTargets: active.every((target) =>
      dshPeerSatisfied(satisfies, target.dshVersion, `>=${target.dshVersion} <${nextCore}-0`)
    ),
    rejectsProbe: !dshPeerSatisfied(satisfies, probe, `<${nextCore}-0`),
  };
  if (!control.acceptsTargets || !control.rejectsProbe) {
    problems.push({
      kind: 'self-check',
      pkg: '<判据自身>',
      file: fileURLToPath(import.meta.url),
      peer: control.range,
      range: control.range,
      detail:
        `规范区间 ${JSON.stringify(control.range)} 正控=${control.acceptsTargets} 负控=${control.rejectsProbe}` +
        ` —— 比较器或目标表已失真，本次结论不可信`,
    });
  }

  /**
   * 3d：提交式 lockfile（`harness-locks/<target>/package-lock.json`）里记录的
   * vendored 包声明必须与 `vendor/` 源一致。
   *
   * 为什么单独查这一面：lock 里的 `"../../vendor/<pkg>"` 条目把该包的 `version`
   * 与 `peerDependencies` **逐字抄了一份**（npm `--package-lock-only` 的产物，
   * 见 `prepare-harness.mjs` 的生成分支）。源改了而 lock 没重生成时，两份声明就打架——
   * 而 `lockInputsMatch` 的四条规则只看根 `dependencies` / `overrides` / 自证字段，
   * **看不见**这一份，于是漂移无声（2026-10-10 实测：两个 lock 里都还写着 `^0.1.2-alpha.4`，
   * 与源里同一处被修好之后仍然不一致）。
   *
   * 只比 `version` 与 `peerDependencies`：这两者是随上游演进最容易漂、且会被运行时
   * 或 npm 真正读取的声明；其余字段由 lock 的安装语义与其它检查覆盖，一并比会把噪声引进来。
   *
   * @param {string} name 包名。
   * @param {object} manifest 源的 package.json。
   */
  const checkLockRecords = (name, manifest) => {
    const normalize = (value) =>
      JSON.stringify(Object.entries(value === null || typeof value !== 'object' ? {} : value).sort());
    for (const targetName of readdirSafe(lockDir)) {
      const lockPath = join(lockDir, targetName, 'package-lock.json');
      if (!existsSync(lockPath)) continue;
      let recorded;
      try {
        recorded = JSON.parse(readFileSync(lockPath, 'utf8'))?.packages ?? {};
      } catch {
        notes.push(`${name}：${lockPath} 解析失败，3d 未执行`);
        continue;
      }
      const key = Object.keys(recorded).find((k) => k.endsWith(`/vendor/${name}`));
      if (key === undefined) {
        notes.push(`${name}：${targetName} 的 lockfile 里没有该包的记录（该目标未组装它？3d 未执行）`);
        continue;
      }
      const entry = recorded[key] ?? {};
      for (const field of ['version', 'peerDependencies']) {
        const want = manifest[field] ?? null;
        const got = entry[field] ?? null;
        if (normalize(want) === normalize(got)) continue;
        problems.push({
          kind: 'lock-stale',
          pkg: name,
          file: lockPath,
          peer: key,
          range: JSON.stringify(want),
          detail:
            `${targetName} 的 lockfile 记的是 ${field}=${JSON.stringify(got)}，` +
            `与源 ${JSON.stringify(want)} 不一致 —— 重跑 \`npm run harness:lockfile\` 重生成提交式 lockfile`,
        });
      }
    }
  };

  for (const name of readdirSafe(vendorDir)) {
    const srcPath = join(vendorDir, name, 'package.json');
    if (!isDirectory(join(vendorDir, name)) || !existsSync(srcPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(srcPath, 'utf8'));
    } catch {
      continue; // 解析不了不是本条规则的职责
    }

    // 3d：**每个** vendored 包都要与提交式 lockfile 的记录比——锁里记的是整份
    // peerDependencies，不只 dsh 家族；非 dsh 的 peer 漂了同样是「声明面互相打架」。
    checkLockRecords(name, manifest);

    const peers = dshPeerRangesOf(manifest);
    if (peers.length === 0) {
      notes.push(`${name}：未声明任何 dsh-* peer（3a/3c 真空通过，3d 仍已执行）`);
      continue;
    }
    checked.packages += 1;

    const installedPath = join(root, name, 'package.json');
    const installedPresent = existsSync(installedPath);
    let installedPeers = new Map();
    if (installedPresent) {
      try {
        installedPeers = new Map(dshPeerRangesOf(JSON.parse(readFileSync(installedPath, 'utf8'))));
      } catch {
        installedPeers = new Map();
      }
    } else {
      notes.push(`${name}：树内 ${join(root, name)} 不存在，3b 未执行（3a/3c 的源判据仍生效）`);
    }

    for (const [peer, range] of peers) {
      checked.peers += 1;

      for (const target of active) {
        if (dshPeerSatisfied(satisfies, target.dshVersion, range)) continue;
        problems.push({
          kind: 'target-mismatch',
          pkg: name,
          file: srcPath,
          peer,
          range,
          detail: `目标 ${target.name}（DSH ${target.dshVersion}）不满足 ${peer} ${JSON.stringify(range)}`,
        });
      }

      if (dshPeerSatisfied(satisfies, probe, range)) {
        problems.push({
          kind: 'too-wide',
          pkg: name,
          file: srcPath,
          peer,
          range,
          detail: `区间过宽：连「下一个 minor」的预发布 ${probe} 也被接受（${peer} ${JSON.stringify(range)}）`,
        });
      }

      if (installedPresent && installedPeers.get(peer) !== range) {
        problems.push({
          kind: 'tree-stale',
          pkg: name,
          file: installedPath,
          peer,
          range,
          detail:
            `树内声明的 ${peer} 是 ${JSON.stringify(installedPeers.get(peer) ?? null)}，` +
            `与源 ${JSON.stringify(range)} 不一致 —— 组装树未带上源里的修复`,
        });
      }
    }
  }

  return { problems, notes, control, checked, dormant, blocked };
}

//#endregion

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

    // --- 规则 3：vendored 包的 dsh-* peer 区间 ---
    //
    // ⚠️ 本组夹具验的是**决策逻辑**（发现 dsh-* peer、3a 目标不相容、3b 树内陈旧、
    //    3c 过宽），**不是** semver 本身：比较器在这里由一个二维表替身注入。
    //    替身是有意的——真实 semver 的结论由本门禁在**真实装配树**上运行时取得
    //    （`loadSemverFromTree`），并在其中跑正控/负控自证。夹具若也实现一套 semver，
    //    就等于给「两套比较器可能分歧」再添一条路。
    check(
      JSON.stringify(nextMinorProbe(['0.2.0-rc.2', '0.2.1-alpha.1'])) ===
        JSON.stringify({ core: '0.3.0', probe: '0.3.0-rc.1' }),
      '规则3：下一个 minor 的探针算错（真实在役目标）'
    );
    check(
      JSON.stringify(nextMinorProbe(['0.2.1-alpha.1', '0.2.0-rc.2'])) ===
        JSON.stringify({ core: '0.3.0', probe: '0.3.0-rc.1' }),
      '规则3：探针不得随目标顺序变化（否则比较器又混进了排序）'
    );
    check(isDshPeerName('@deepseek-ai/dsh'), '规则3：`@deepseek-ai/dsh` 本身必须进门禁');
    check(isDshPeerName('@deepseek-ai/dsh-settings'), '规则3：`@deepseek-ai/dsh-*` 必须进门禁');
    // 负控：非 dsh 家族的 peer **不**进门禁（进门禁就会把无害的 peer 判红）。
    check(!isDshPeerName('@deepseek-ai/cordis'), '规则3：`@deepseek-ai/cordis` 不应进门禁');
    check(!isDshPeerName('@other/dsh-x'), '规则3：别的 scope 下的 dsh- 前缀不应进门禁');
    check(
      dshPeerRangesOf({
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-x': '^1.0.0' },
      }).length === 1,
      '规则3：筛选后应只剩 dsh 家族的 peer'
    );

    const T = '1.2.0-rc.2'; // 夹具目标的运行时
    const P = '1.3.0-rc.1'; // 探针（= 下一个 minor 的预发布）
    const GOOD = `>=${T} <1.3.0-0`;
    const STALE = '^0.1.2-alpha.4'; // 真实事故里的旧写法
    const WIDE = '*'; // 「一律放行」的写法，必须被 3c 挡住
    const TABLE = {
      [`${T}|${GOOD}`]: true,
      [`${T}|${STALE}`]: false,
      [`${T}|${WIDE}`]: true,
      [`${P}|${GOOD}`]: false,
      [`${P}|${STALE}`]: false,
      [`${P}|${WIDE}`]: true,
      [`${P}|<1.3.0-0`]: false // 内部控制的负控用的上界
    };
    const stubSatisfies = (runtime, range) => TABLE[`${runtime}|${range}`] ?? false;
    const rule3Targets = [{ name: 'fixture', status: 'active', dshVersion: T }];

    const rule3Vendor = join(base, 'rule3-vendor');
    const rule3Tree = join(base, 'rule3-tree');
    const putRule3 = (dir, pkg, peerRange) => {
      mkdirSync(join(dir, pkg), { recursive: true });
      writeFileSync(
        join(dir, pkg, 'package.json'),
        JSON.stringify({ name: pkg, version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-settings': peerRange } }),
        'utf8'
      );
    };
    // 源四个包：正确 / 源陈旧(3a) / 源过宽(3c) / 无 dsh peer(真空通过)
    putRule3(rule3Vendor, 'rule3-fresh', GOOD);
    putRule3(rule3Vendor, 'rule3-stale-src', STALE);
    putRule3(rule3Vendor, 'rule3-wide', WIDE);
    mkdirSync(join(rule3Vendor, 'rule3-none'), { recursive: true });
    writeFileSync(
      join(rule3Vendor, 'rule3-none', 'package.json'),
      JSON.stringify({ name: 'rule3-none', version: '1.0.0', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }),
      'utf8'
    );
    // 树内：fresh 与源一致；stale-tree 与源**不一致**（改了源、发的旧拷贝）
    putRule3(rule3Tree, 'rule3-fresh', GOOD);
    putRule3(rule3Tree, 'rule3-stale-src', STALE);
    putRule3(rule3Tree, 'rule3-wide', WIDE);
    putRule3(rule3Tree, 'rule3-stale-tree', GOOD);
    putRule3(rule3Vendor, 'rule3-stale-tree', GOOD);
    putRule3(rule3Tree, 'rule3-stale-tree', STALE); // 覆盖成陈旧拷贝

    // 3d 夹具：两个目标各一份 lockfile —— `next` 记的与源一致（正控），`alpha` 记的是旧值（负控）。
    const rule3LockDir = join(base, 'rule3-locks');
    const putLock = (target, entries) => {
      mkdirSync(join(rule3LockDir, target), { recursive: true });
      writeFileSync(
        join(rule3LockDir, target, 'package-lock.json'),
        JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: entries }, null, 2),
        'utf8'
      );
    };
    const lockEntry = (peerRange) => ({
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-settings': peerRange },
    });
    putRule3(rule3Vendor, 'rule3-lock', GOOD);
    putRule3(rule3Tree, 'rule3-lock', GOOD);
    putLock('next', {
      '../../vendor/rule3-fresh': lockEntry(GOOD),
      '../../vendor/rule3-lock': lockEntry(GOOD),
    });
    putLock('alpha', {
      '../../vendor/rule3-fresh': lockEntry(GOOD),
      '../../vendor/rule3-lock': lockEntry(STALE), // 源已修、lock 未重生成
    });

    let r3 = verifyVendorPeerRanges(rule3Tree, {
      vendorDir: rule3Vendor,
      lockDir: rule3LockDir,
      targets: rule3Targets,
      satisfies: stubSatisfies,
    });
    const kindsOf = (pkg) => r3.problems.filter((p) => p.pkg === pkg).map((p) => p.kind);
    check(r3.blocked.length === 0, `规则3：不应判成「判不了」（${r3.blocked.join('；')}）`);
    check(r3.control?.acceptsTargets === true, '规则3：内部控制正控不成立');
    check(r3.control?.rejectsProbe === true, '规则3：内部控制负控不成立');
    check(
      !r3.problems.some((p) => p.kind === 'self-check'),
      '规则3：内部控制报「判据自身失真」'
    );
    check(kindsOf('rule3-fresh').length === 0, '规则3 正控：源与树都正确的包被误报');
    check(
      kindsOf('rule3-stale-src').includes('target-mismatch'),
      '规则3 3a：源里陈旧的 peer 区间（真实事故写法）未被报出'
    );
    check(kindsOf('rule3-wide').includes('too-wide'), '规则3 3c：`*` 这种「一律放行」未被报出——3c 形同虚设');
    check(
      kindsOf('rule3-stale-tree').includes('tree-stale'),
      '规则3 3b：树内是陈旧拷贝（与源不一致）却未被报出'
    );
    check(
      kindsOf('rule3-lock').length === 1 && kindsOf('rule3-lock').includes('lock-stale'),
      '规则3 3d：lockfile 记的是旧声明（源已修、lock 未重生成）却未被报出'
    );
    check(
      !r3.problems.some((p) => p.kind === 'lock-stale' && p.file.includes('next')),
      '规则3 3d 正控：与源一致的 lockfile 被误报'
    );
    check(
      r3.notes.some((note) => note.includes('没有该包的记录')),
      '规则3 3d：源有 dsh peer 但 lock 里没有该包时必须**打印**说明，否则「跳过」与「通过」同形'
    );
    check(
      r3.notes.some((note) => note.includes('rule3-none')),
      '规则3：无 dsh peer 的包必须**打印**跳过原因，否则「跳过」与「通过」同形'
    );
    check(r3.checked.packages === 5, `规则3：被判定的包数不对（${r3.checked.packages}）`);
    check(r3.checked.peers === 5, `规则3：被判定的 peer 数不对（${r3.checked.peers}）`);
    check(r3.dormant.length === 0, '规则3：夹具里没有休眠目标，不该有');

    // 可伪证性：把五类缺陷全部消掉，必须转为全通过——否则这个检查器只会无脑报错。
    putRule3(rule3Vendor, 'rule3-stale-src', GOOD);
    putRule3(rule3Tree, 'rule3-stale-src', GOOD);
    putRule3(rule3Vendor, 'rule3-wide', GOOD);
    putRule3(rule3Tree, 'rule3-wide', GOOD);
    putRule3(rule3Tree, 'rule3-stale-tree', GOOD);
    putLock('alpha', {
      '../../vendor/rule3-fresh': lockEntry(GOOD),
      '../../vendor/rule3-lock': lockEntry(GOOD),
    });
    r3 = verifyVendorPeerRanges(rule3Tree, {
      vendorDir: rule3Vendor,
      lockDir: rule3LockDir,
      targets: rule3Targets,
      satisfies: stubSatisfies,
    });
    check(
      r3.problems.length === 0,
      `规则3 可伪证性：消除全部缺陷后仍报 ${r3.problems.length} 处（${r3.problems
        .map((p) => `${p.pkg}/${p.kind}`)
        .slice(0, 5)
        .join(', ')}），检查器不可信`
    );
    // 判不了的必须判红，而不是静默通过（「取不到 semver ⇒ 全绿」是最坏的失效形态）。
    check(
      verifyVendorPeerRanges(rule3Tree, { vendorDir: rule3Vendor, targets: rule3Targets }).blocked.length === 1,
      '规则3：未注入比较器时必须报「判不了」，而不是返回空问题集'
    );
    check(
      verifyVendorPeerRanges(rule3Tree, { vendorDir: rule3Vendor, targets: [], satisfies: stubSatisfies }).blocked
        .length === 1,
      '规则3：没有在役目标时必须报「无判据被执行」，空集不得冒充通过'
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
      console.error('默认只跑三条**零噪声**规则（作为门禁）：');
      console.error('  规则1 树内不得存在逃出树外的符号链接（file: 依赖未实体化）');
      console.error('  规则2 dsh-desktop-* 插件的裸导入必须能在树内解析');
      console.error('  规则3 vendored 包的 dsh-* peer 区间必须与在役目标相容、与源一致、且不过宽');
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

    const semver = loadSemverFromTree(resolved);
    const vendor = verifyVendorPeerRanges(resolved, { satisfies: semver?.satisfies ?? null });
    const comparator = semver === null ? '取不到内建 semver' : `树内 semver ${semver.version}`;
    const targetsText = `在役目标 ${vendor.checked.activeTargets} 个${vendor.dormant.length > 0 ? `（休眠 ${vendor.dormant.join('/')} 已跳过）` : ''}`;
    if (vendor.blocked.length > 0) {
      console.log(`❌ 规则3：**判不了**，因此不能算通过——${vendor.blocked.join('；')}`);
      failing.push('规则3');
    } else if (vendor.problems.length === 0) {
      console.log(
        `✅ 规则3：vendored 包 ${vendor.checked.packages} 个 / dsh-* peer ${vendor.checked.peers} 个 / ` +
          `${targetsText}全部相容（比较器：${comparator}；探针 ${vendor.control.probe} 已被拒绝）。`
      );
    } else {
      console.log(
        `❌ 规则3：${vendor.problems.length} 处 —— 上游 peer 门禁会把它们静默降级` +
          `（bundle 跳过 / 插件行停用），用户看到的是「已安装却用不了」。`
      );
      const guidance = {
        'target-mismatch': '该区间不满足在役运行时。改法：写成 `>=<最低在役版本> <下一个 minor>-0`（上界的 `-0` 不能省，见 nextMinorProbe 注释）。',
        'too-wide': '区间过宽：把下一个 minor 也放行了。改法：收上界到 `<下一个 minor>-0`；不要用 `*`。',
        'tree-stale': '源已修但**组装树是旧拷贝**。改法：重跑 `npm run prepare:harness`（`src-tauri/resources/` 是 gitignore 的产物）。',
        'lock-stale': '源已修但**提交式 lockfile 还记着旧声明**。改法：重跑 `npm run harness:lockfile` 重生成（next 线全量解析，约 40 分钟）。',
        'self-check': '判据自身失真（比较器或目标表），先修这里再看其它条目。',
      };
      for (const item of vendor.problems.slice(0, 20)) {
        console.log(`    [${item.kind}] ${item.pkg}: ${item.peer} ${JSON.stringify(item.range)}`);
        console.log(`        · ${item.detail}`);
        const advice = guidance[item.kind];
        if (advice) console.log(`        → ${advice}`);
      }
      if (vendor.problems.length > 20) console.log(`    …另有 ${vendor.problems.length - 20} 处`);
      failing.push('规则3');
    }
    for (const note of vendor.notes) console.log(`    ⏭  ${note}（跳过不等于通过）`);

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
