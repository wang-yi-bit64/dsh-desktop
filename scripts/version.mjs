#!/usr/bin/env node
/**
 * version.mjs — 版本号的定义、校验与推进
 *
 * ## 版本号怎么定义（单一真源）
 *
 * | 位置 | 角色 | 谁写 |
 * |------|------|------|
 * | `package.json` → `version` | **唯一真源** | 本脚本 |
 * | `src-tauri/tauri.conf.json` → `version` | 指向 `../package.json`，**不重复存值** | 手工设一次即可 |
 * | `Cargo.toml` → `[workspace.package] version` | 跟随真源（Cargo 读不了 package.json） | 本脚本 |
 * | `Cargo.lock` | 生成物，跟随 Cargo.toml | cargo 自身 |
 *
 * 为什么把真源放在 `package.json`：Tauri 官方 schema 允许 `version` 直接写
 * 「`package.json` 的路径」（原文：*"It is a semver version number or a path to a
 * `package.json` file containing the `version` field"*），因此 `tauri.conf.json`
 * 能**原生继承**而不必存第二份值——三处重复就此消掉一处。
 * 剩下 Cargo 那一处必须靠脚本同步，因为 Cargo 不支持读外部文件。
 *
 * ## 版本号怎么推进
 *
 * 规则与 Conventional Commits 的语义对齐（也是对外可预期的约定）：
 *
 * | 提交内容 | 推进 | 例子 |
 * |---------|------|------|
 * | 任一破坏性变更（`!` 或 `BREAKING CHANGE:` 页脚） | `major` | 0.3.1 → 1.0.0 |
 * | 任一 `feat` | `minor` | 0.1.0 → 0.2.0 |
 * | 任一 `fix` / `perf` | `patch` | 0.2.0 → 0.2.1 |
 * | 只有 `docs` / `chore` / `ci` 等 | `none` | **不发版**（产物无行为变化） |
 *
 * 预发布版本用 `-` 后缀（`0.2.0-beta.1`），对应的 GitHub Release 会被标为
 * prerelease，且**不会**进入 updater 的 `latest.json` 通道（Tauri 的版本比较
 * 认为预发布低于同号正式版）。
 *
 * `1.0.0` 之前（`0.y.z`）的约定：破坏性变更升 `minor`，因为此时 API 本就未稳定，
 * 用 `major` 会把版本号推得比实际成熟度快。本仓库当前处于此阶段。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/version.mjs show                      # 显示各处版本与本仓库状态
 * node scripts/version.mjs check                     # 校验一致性（CI 门禁；tag 构建时校验 tag 与版本匹配）
 * node scripts/version.mjs check --tag v0.2.0        # 显式指定 tag
 * node scripts/version.mjs set 0.2.0                 # 直接指定版本（唯一真源 + 跟随处一起改）
 * node scripts/version.mjs bump auto                 # 按提交历史自动决定升哪一位
 * node scripts/version.mjs bump minor --tag          # 升 minor 并打 tag（tag 默认不推送）
 * node scripts/version.mjs --self-test               # 纯逻辑自测
 * ```
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { latestTag, readCommits, suggestBump } from './conventional-commits.mjs';
import { insertSection, renderSection, repoUrl } from './changelog.mjs';

/** 需要保持同步的 Cargo 工作区成员（Cargo.lock 里的校验对象）。 */
const CARGO_CRATES = ['dsh-desktop', 'dsh-contracts', 'dsh-host', 'dsh-host-cli'];

// ---------------------------------------------------------------------------
// SemVer 纯逻辑
// ---------------------------------------------------------------------------

/**
 * 解析 semver 字符串。
 *
 * @param {string} value - 形如 `1.2.3`、`0.2.0-beta.1`、`1.0.0+build.5`。
 * @returns {{ major: number, minor: number, patch: number, prerelease: string|null, build: string|null }|null}
 *   解析结果；不合法时返回 `null`（调用方据此报错，不抛异常以便批量校验）。
 */
export function parseSemver(value) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$/.exec(
    String(value).trim(),
  );
  if (!match) return null;
  const { major, minor, patch, pre, build } = match.groups;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre || null,
    build: build || null,
  };
}

/**
 * 按位递增版本号。
 *
 * 递增会**丢弃**原有的 prerelease / build 后缀（`0.2.0-beta.1` 升 `patch`
 * 得到 `0.2.1`，而不是 `0.2.1-beta.1`）——后缀描述的是「这一版还没定稿」，
 * 换版本号后那个判断已失效。
 *
 * @param {string} current - 当前版本。
 * @param {'major'|'minor'|'patch'} part - 要提升的位。
 * @returns {string} 新版本字符串。
 * @throws {Error} 当前版本不合法，或 `part` 不是三者之一。
 */
export function increment(current, part) {
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`当前版本不是合法 semver：${JSON.stringify(current)}`);
  if (!['major', 'minor', 'patch'].includes(part)) {
    throw new Error(`只能升 major / minor / patch，收到：${part}`);
  }
  if (part === 'major') return `${parsed.major + 1}.0.0`;
  if (part === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/**
 * 读取 package.json 的 version 与 Cargo.toml 的 workspace version、tauri.conf.json 的 version 字段。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {{ pkgVersion: string|null, cargoVersion: string|null, tauriVersion: string|null,
 *   tauriInherits: boolean, files: { pkg: string, cargo: string, tauri: string } }}
 *   各处版本；读不到（文件缺失或格式异常）时对应字段为 `null`。
 */
export function readVersions(root = process.cwd()) {
  const files = {
    pkg: path.join(root, 'package.json'),
    cargo: path.join(root, 'Cargo.toml'),
    tauri: path.join(root, 'src-tauri', 'tauri.conf.json'),
  };

  let pkgVersion = null;
  let cargoVersion = null;
  let tauriVersion = null;

  try {
    pkgVersion = JSON.parse(readFileSync(files.pkg, 'utf8')).version ?? null;
  } catch {
    /* 缺失即 null，由 check 报错 */
  }
  try {
    // 只认 `[workspace.package]` 段里的 version，避免把 `[workspace.dependencies]`
    // 里某个依赖的 `version = "..."` 误当成自己的版本。
    const toml = readFileSync(files.cargo, 'utf8');
    const section = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/.exec(toml);
    cargoVersion = section ? (/^\s*version\s*=\s*"([^"]+)"/m.exec(section[1])?.[1] ?? null) : null;
  } catch {
    /* 同上 */
  }
  try {
    tauriVersion = JSON.parse(readFileSync(files.tauri, 'utf8')).version ?? null;
  } catch {
    /* 同上 */
  }

  // Tauri 支持 version 写成「指向 package.json 的路径」，此时它不持值而是继承。
  const tauriInherits = Boolean(tauriVersion) && tauriVersion.includes('package.json');

  return { pkgVersion, cargoVersion, tauriVersion, tauriInherits, files };
}

/**
 * 把版本号写入 package.json 与 Cargo.toml（唯一真源 + 跟随处）。
 *
 * 写入用**定点替换**而不是 `JSON.parse` → 整体 `JSON.stringify`：后者会重排
 * 键序、可能改动缩进，把一次版本变更变成一整文件 diff——审阅时看不出真正改了什么。
 *
 * @param {string} version - 新版本号。
 * @param {string} [root] - 仓库根路径。
 * @returns {{ changed: string[] }} 实际被改写的文件路径。
 */
export function writeVersion(version, root = process.cwd()) {
  if (!parseSemver(version)) throw new Error(`拒绝写入非法版本号：${JSON.stringify(version)}`);
  const { files } = readVersions(root);
  const changed = [];

  const pkgRaw = readFileSync(files.pkg, 'utf8');
  const pkgNext = pkgRaw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`);
  if (pkgNext !== pkgRaw) {
    writeFileSync(files.pkg, pkgNext, 'utf8');
    changed.push(files.pkg);
  }

  const cargoRaw = readFileSync(files.cargo, 'utf8');
  const cargoNext = cargoRaw.replace(
    /(\[workspace\.package\][\s\S]*?^\s*version\s*=\s*")([^"]*)(")/m,
    `$1${version}$3`,
  );
  if (cargoNext !== cargoRaw) {
    writeFileSync(files.cargo, cargoNext, 'utf8');
    changed.push(files.cargo);
  }

  return { changed };
}

/**
 * 让 cargo 自身刷新 Cargo.lock 里的工作区成员版本。
 *
 * 不手工改 lock：那是 cargo 的生成物，手改容易与 cargo 的内部表示不一致。
 * 失败时**不抛错**——lock 会在下次 `cargo build` 时自动跟上，而版本号本身
 * 已经写对了；这里失败只值得提示，不值得让 `version:set` 整体失败。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {{ ok: boolean, detail: string }} 是否刷新成功及原因。
 */
export function refreshLock(root = process.cwd()) {
  try {
    execFileSync('cargo', ['update', '--workspace', '--offline'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, detail: '已用 `cargo update --workspace --offline` 刷新 Cargo.lock' };
  } catch (error) {
    return {
      ok: false,
      detail: `Cargo.lock 未刷新（${(error.stderr || error.message || '').toString().trim().split('\n')[0]}）；下次 cargo 构建会自动跟上`,
    };
  }
}

/**
 * 为指定版本重新生成 CHANGELOG.md 的对应段落。
 *
 * 为什么由 `--commit` 顺带做（而不是让调用者自己再跑一条命令）：
 * 发布提交必须是**原子**的。若版本号与变更日志分两个提交落下，那么 tag 很容易
 * 打在「有版本号、没有变更日志」的那个提交上——CHANGELOG.md 从此永久滞后一版，
 * 而它恰恰是给人看的那份东西。两件事同属「这一次发布」，就该同属一个提交。
 *
 * @param {string} version - 新版本号。
 * @param {string} [root] - 仓库根路径。
 * @returns {{ ok: boolean, detail: string }} 是否写入成功。
 */
export function writeChangelogSection(version, root = process.cwd()) {
  try {
    const from = latestTag({ cwd: root });
    const commits = readCommits({ from, to: 'HEAD', cwd: root });
    if (commits.length === 0) {
      return { ok: false, detail: '区间内没有提交，CHANGELOG.md 未改动' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const section = renderSection(commits, {
      base: repoUrl(root),
      heading: `## [${version}] - ${date}`,
    });
    const file = path.join(root, 'CHANGELOG.md');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // force=true：这是「重新生成」，同版本段落若已存在应被替换而非追加。
    writeFileSync(file, insertSection(existing, section, version, true), 'utf8');
    return { ok: true, detail: `已更新 CHANGELOG.md（${commits.length} 条提交）` };
  } catch (error) {
    // 不阻断版本号写入：版本号本身是对的，变更日志可以在提交前人工补。
    // 但必须显式说出来——静默跳过会让人以为已经写好了。
    return { ok: false, detail: `CHANGELOG.md 未更新：${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验版本一致性。
 *
 * 硬失败（阻断）：
 *   1. `package.json` 的 version 是合法 semver；
 *   2. `tauri.conf.json` 要么指向 `../package.json`，要么与真源逐字相同；
 *   3. `Cargo.toml` 的 workspace version 与真源相同；
 *   4. 给了 tag 时，tag 必须等于 `v<version>`。
 *
 * 软提示（不阻断）：`Cargo.lock` 未跟上——它是生成物，会在下次构建时自愈。
 *
 * 第 4 条是发布链路的**关键防线**：如果 tag 与版本号不一致，打出来的包会
 * 声称自己是另一个版本，而 updater 的版本比较据此决定推不推更新——错一次就会
 * 让所有已安装用户收到一个「版本号没变」的更新或永远收不到更新。
 *
 * @param {object} [options]
 * @param {string|null} [options.tag] - 待校验的 tag（形如 `v0.2.0`）。
 * @param {string} [options.root] - 仓库根路径。
 * @returns {{ errors: string[], warnings: string[], version: string|null }} 校验结果。
 */
export function checkVersions(options = {}) {
  const { tag = null, root = process.cwd() } = options;
  const errors = [];
  const warnings = [];
  const { pkgVersion, cargoVersion, tauriVersion, tauriInherits, files } = readVersions(root);

  if (!pkgVersion) {
    errors.push(`读不到 package.json 的 version（${files.pkg}）——它是版本号的唯一真源`);
  } else if (!parseSemver(pkgVersion)) {
    errors.push(`package.json 的 version 不是合法 semver：${JSON.stringify(pkgVersion)}`);
  }

  if (pkgVersion) {
    if (!tauriVersion) {
      errors.push(`读不到 tauri.conf.json 的 version（${files.tauri}）`);
    } else if (!tauriInherits && tauriVersion !== pkgVersion) {
      errors.push(
        `tauri.conf.json 的 version（${tauriVersion}）与真源（${pkgVersion}）不一致。` +
          `建议改成 "version": "../package.json" 让它原生继承，从根上消除这处重复`,
      );
    }

    if (!cargoVersion) {
      errors.push(`读不到 Cargo.toml 的 [workspace.package] version`);
    } else if (cargoVersion !== pkgVersion) {
      errors.push(
        `Cargo.toml 的 workspace version（${cargoVersion}）与真源（${pkgVersion}）不一致。` +
          `修复：node scripts/version.mjs set ${pkgVersion}（或 bump）`,
      );
    }

    if (tag) {
      const expected = `v${pkgVersion}`;
      if (tag !== expected) {
        errors.push(
          `tag（${tag}）与版本号（${pkgVersion}）不匹配，期望 ${expected}。` +
            `发布前必须一致：不一致会让安装包自称另一个版本，updater 的版本比较随之失效`,
        );
      }
    }
  }

  // Cargo.lock 只是提示：它是生成物，且其内容由 cargo 维护。
  try {
    const lock = readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
    const stale = CARGO_CRATES.filter((crate) => {
      const stanza = new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`).exec(lock);
      return stanza && stanza[1] !== pkgVersion;
    });
    if (stale.length > 0) {
      warnings.push(
        `Cargo.lock 里 ${stale.join(', ')} 的版本未跟上真源（${pkgVersion}）。` +
          `修复：cargo update --workspace（下次 cargo 构建也会自动跟上）`,
      );
    }
  } catch {
    warnings.push('读不到 Cargo.lock，跳过其一致性检查');
  }

  return { errors, warnings, version: pkgVersion };
}

/**
 * 判定 tag 是否代表预发布版本。
 *
 * @param {string} version - 版本号。
 * @returns {boolean} 含 prerelease 后缀即为 `true`。
 */
export function isPrerelease(version) {
  return Boolean(parseSemver(version)?.prerelease);
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

/**
 * 纯逻辑自测：不调用 git。非法输入在校验阶段就被拒绝，**不会触达文件写入**，
 * 因此对工作区没有副作用。
 *
 * @returns {{ passed: number }} 通过项数（计数器统计，不是手写常量）。
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项。
 */
export function selfTest() {
  const failures = [];
  // 计数器而不是手写数字：手写的「通过 N 项」会随断言增删悄悄失真，
  // 而一个失真的数字本身就是错误宣称。
  let passed = 0;
  const eq = (label, got, want) => {
    passed += 1;
    if (got !== want) failures.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  };
  const throws = (label, fn) => {
    passed += 1;
    try {
      fn();
      failures.push(`${label}：应当报错但没有`);
    } catch {
      /* 预期内 */
    }
  };

  // semver 解析：合法与非法都要覆盖，否则「拒绝非法版本号」这层防线无从验证。
  eq('解析 1.2.3', JSON.stringify(parseSemver('1.2.3')), JSON.stringify({ major: 1, minor: 2, patch: 3, prerelease: null, build: null }));
  eq('解析预发布', parseSemver('0.2.0-beta.1')?.prerelease, 'beta.1');
  eq('解析 build', parseSemver('1.0.0+build.5')?.build, 'build.5');
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', 'abc', '', '1.2.x']) {
    eq(`拒绝非法版本 ${JSON.stringify(bad)}`, parseSemver(bad), null);
  }

  // 递增：三种位 + 后缀丢弃。
  eq('升 major', increment('0.3.1', 'major'), '1.0.0');
  eq('升 minor', increment('0.3.1', 'minor'), '0.4.0');
  eq('升 patch', increment('0.3.1', 'patch'), '0.3.2');
  eq('递增丢弃预发布后缀', increment('0.3.1-beta.2', 'patch'), '0.3.2');
  throws('非法当前版本递增', () => increment('bad', 'patch'));
  throws('非法提升位', () => increment('1.2.3', 'huge'));
  throws('拒绝写入非法版本号', () => writeVersion('1.2'));

  // 预发布判定（决定 GitHub Release 是否标 prerelease）。
  eq('正式版不是预发布', isPrerelease('1.2.3'), false);
  eq('带后缀是预发布', isPrerelease('1.2.3-rc.1'), true);

  // 与提交历史的衔接：auto 的四种结论必须与 suggestBump 一致。
  const commits = (subjects) => subjects.map((subject, index) => ({ sha: `${index}`.padEnd(40, '0'), subject, body: '' }));
  const bumpFrom = (subjects) =>
    suggestBump(commits(subjects).map((raw) => ({ ...raw, ...parseForBump(raw.subject) })));
  eq('auto：feat → minor', bumpFrom(['feat: x']), 'minor');
  eq('auto：fix → patch', bumpFrom(['fix: x']), 'patch');
  eq('auto：docs → none', bumpFrom(['docs: x']), 'none');

  if (failures.length > 0) {
    throw new Error(`version 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

/**
 * 自测内部的轻量解析（只取 type / breaking），避免为了自测去建 git 仓库。
 *
 * @param {string} subject - 提交主题。
 * @returns {{ type: string|null, breaking: boolean }} 解析结果。
 */
function parseForBump(subject) {
  const match = /^([a-zA-Z]+)(?:\([^)]*\))?(!)?:/.exec(subject);
  return match ? { type: match[1], breaking: Boolean(match[2]) } : { type: null, breaking: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `version.mjs — 版本号的定义、校验与推进

  show                       显示各处版本与本仓库状态
  check [--tag vX.Y.Z]       校验一致性（CI 门禁）
  set <x.y.z> [--commit] [--tag] [--dry-run]
                             直接指定版本（改 package.json + Cargo.toml）
  bump <major|minor|patch|auto> [--commit] [--tag] [--from <ref>] [--dry-run]
                             推进版本；auto 依据提交历史决定升哪一位
  --self-test                纯逻辑自测
  --help                     显示本帮助

说明：--tag 只创建本地 tag，**不会**推送（推送与否由人决定）。
      --dry-run 只打印将要发生的事，不写文件、不提交、不打 tag。
      --commit 会**顺带重新生成 CHANGELOG.md 的对应段落**并一起提交——
              版本号与变更日志同属一个原子发布提交，避免 tag 打在缺变更日志的提交上。`;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{ command: string, arg: string|null, tag: string|null, explicitTag: boolean,
 *   commit: boolean, dryRun: boolean, from: string|null, selfTest: boolean, help: boolean }} 选项。
 */
function parseArgs(argv) {
  const options = {
    command: 'show',
    arg: null,
    tag: null,
    explicitTag: false,
    commit: false,
    dryRun: false,
    from: null,
    selfTest: false,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--commit') options.commit = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--tag') {
      options.explicitTag = true;
      // `--tag` 后面跟了值就用，否则视为「用推导出的版本自动生成 tag」。
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        options.tag = next;
        i += 1;
      }
    } else if (arg === '--from') options.from = argv[++i];
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}（--help 查看用法）`);
    else positional.push(arg);
  }
  if (positional.length > 0) options.command = positional[0];
  if (positional.length > 1) options.arg = positional[1];
  return options;
}

/** 执行 git 命令并把输出透传（tag / commit 操作用）。 */
function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

/**
 * CLI 主入口。
 *
 * @param {string[]} argv - 命令行参数。
 * @returns {void}
 */
function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (options.selfTest) {
    const { passed } = selfTest();
    console.log(`✅ version 自测通过（${passed} 项）`);
    return;
  }

  const { pkgVersion, cargoVersion, tauriVersion, tauriInherits } = readVersions();

  if (options.command === 'show') {
    console.log('版本号单一真源与跟随处：');
    console.log(`  package.json                ${pkgVersion ?? '(读不到)'}   ← 唯一真源`);
    console.log(
      `  src-tauri/tauri.conf.json   ${tauriInherits ? `${tauriVersion}（继承真源）` : `${tauriVersion ?? '(读不到)'}${tauriVersion === pkgVersion ? '（与真源一致）' : ' ⚠️ 与真源不一致'}`}`,
    );
    console.log(
      `  Cargo.toml [workspace]      ${cargoVersion ?? '(读不到)'}${cargoVersion === pkgVersion ? '（与真源一致）' : ' ⚠️ 与真源不一致'}`,
    );
    const tag = latestTag();
    console.log(`  最近 tag                    ${tag ?? '(无 —— 尚未发布过)'}`);
    if (!tag) {
      console.log('\n尚未打过任何 tag：首次发布请用 `version.mjs set <x.y.z>`（不需要 bump 推导）。');
    } else {
      const since = readCommits({ from: tag, to: 'HEAD' });
      console.log(`  ${tag} 以来的提交            ${since.length} 条，建议升级位：${suggestBump(since)}`);
    }
    return;
  }

  if (options.command === 'check') {
    // CI 上不必显式传 tag：tag 触发时 GITHUB_REF_NAME 就是 tag 名。
    const tag =
      options.tag ??
      (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null) ??
      null;
    const { errors, warnings, version } = checkVersions({ tag });

    for (const warning of warnings) console.warn(`⚠️  ${warning}`);
    if (errors.length > 0) {
      for (const error of errors) console.error(`❌ ${error}`);
      console.error(`\n版本一致性校验失败（${errors.length} 项）`);
      process.exit(1);
    }
    console.log(
      `✅ 版本一致性校验通过：${version}` +
        (tag ? `（tag ${tag} 与版本匹配）` : '（未提供 tag，跳过 tag 匹配检查）'),
    );
    return;
  }

  if (options.command === 'set' || options.command === 'bump') {
    let nextVersion;

    if (options.command === 'set') {
      if (!options.arg) throw new Error('set 需要版本号：version.mjs set 0.2.0');
      if (!parseSemver(options.arg)) throw new Error(`不是合法 semver：${JSON.stringify(options.arg)}`);
      nextVersion = options.arg;
    } else {
      const part = options.arg || 'auto';
      if (part === 'auto') {
        const from = options.from ?? latestTag();
        if (!from) {
          throw new Error(
            '仓库里没有任何 tag，无法「自动」判断升哪一位——首次发布请用 `version.mjs set <x.y.z>`。\n' +
              '（不在无基线的情况下猜一个版本号：猜错会让首个发布版本与后续更新的比较语义变得含糊）',
          );
        }
        const commits = readCommits({ from, to: 'HEAD' });
        const suggestion = suggestBump(commits);
        if (suggestion === 'none') {
          console.log(`ℹ️  ${from} 以来只有文档 / 杂务类提交（${commits.length} 条），按规则不发版。`);
          console.log('   确有需要请显式指定：version.mjs bump patch');
          return;
        }
        nextVersion = increment(pkgVersion, suggestion);
        console.log(`依据 ${from}..HEAD 的 ${commits.length} 条提交判定：升 ${suggestion} → ${nextVersion}`);
      } else {
        nextVersion = increment(pkgVersion, part);
      }
    }

    if (options.dryRun) {
      console.log(`\n🔍 --dry-run：不会改动任何文件`);
      console.log(`   将把版本号 ${pkgVersion} → ${nextVersion}`);
      console.log(`   将改写 package.json、Cargo.toml${options.commit ? '，并提交 chore(release): ' + nextVersion : ''}`);
      const plannedTag = options.tag || (options.explicitTag ? `v${nextVersion}` : null);
      if (plannedTag) console.log(`   将创建本地 tag ${plannedTag}（不推送）`);
      return;
    }

    const { changed } = writeVersion(nextVersion);
    console.log(`✅ 版本号 ${pkgVersion} → ${nextVersion}`);
    for (const file of changed) console.log(`   已改写 ${path.relative(process.cwd(), file)}`);
    const lock = refreshLock();
    console.log(`   ${lock.ok ? '🔒' : 'ℹ️ '} ${lock.detail}`);

    const tagName = options.tag || (options.explicitTag ? `v${nextVersion}` : null);
    if (options.commit) {
      // 先落变更日志，再一起提交——见 writeChangelogSection 的注释：
      // 版本号与变更日志必须同属一个提交，否则 tag 会打在缺变更日志的提交上。
      const changelog = writeChangelogSection(nextVersion);
      console.log(`   ${changelog.ok ? '📝' : '⚠️ '} ${changelog.detail}`);
      const filesToAdd = ['package.json', 'Cargo.toml', 'Cargo.lock'];
      if (changelog.ok) filesToAdd.push('CHANGELOG.md');
      git(['add', ...filesToAdd]);
      git(['commit', '-m', `chore(release): ${nextVersion}`]);
      console.log(`   已提交 chore(release): ${nextVersion}（含 ${filesToAdd.join(', ')}）`);
    }
    if (tagName) {
      git(['tag', '-a', tagName, '-m', `Release ${nextVersion}`]);
      console.log(`   已创建本地 tag ${tagName}（未推送）`);
      console.log(`   推送：git push origin HEAD --follow-tags`);
    }
    return;
  }

  throw new Error(`未知子命令：${options.command}（--help 查看用法）`);
}
