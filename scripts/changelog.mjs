#!/usr/bin/env node
/**
 * changelog.mjs — 从 git 提交历史生成 CHANGELOG.md 与 release notes
 *
 * ## 为什么存在
 *
 * 本仓库的历史提交**本身就是规范化的**（`feat(shell): …` / `fix(ci): …`），
 * 因此「变更历史」不需要人工另写一份——那必然与提交历史逐渐背离，最后变成
 * 一份没人信、也没人更新的文档。这里让变更日志**由提交历史推导**：唯一事实源
 * 是 git，写出来的东西永远与代码同步。
 *
 * 为什么不用 GitHub 内置的 `--generate-notes`：它按**已合并的 PR** 归纳，而本
 * 仓库全程直推 `main`（`gh pr list --state all` 为空），实测产出只有一个
 * Full Changelog 链接、没有任何条目。直推流程下这条路走不通。
 *
 * ## 产物与去向
 *
 * | 产物 | 命令 | 去向 |
 * |------|------|------|
 * | 仓库内 `CHANGELOG.md` | `npm run changelog:write -- --version 0.2.0` | 入库，按版本分段累积 |
 * | Release 正文 | `npm run changelog:notes -- --from v0.1.0` | `.github/workflows/release.yml` 注入 GitHub Release |
 *
 * 两者共用同一解析器与同一渲染逻辑，因此**不会出现「Release 页说的」与
 * 「CHANGELOG.md 说的」不一致**——那正是维护两份文档必然的结局。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/changelog.mjs --notes                     # 打印 release 正文（上个 tag..HEAD）
 * node scripts/changelog.mjs --notes --from v0.1.0 --to v0.2.0
 * node scripts/changelog.mjs --write --version 0.2.0     # 写入 CHANGELOG.md
 * node scripts/changelog.mjs --self-test                 # 渲染逻辑自测（无需 git）
 * ```
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BREAKING_TITLE,
  classify,
  latestTag,
  parseCommit,
  readCommits,
} from './conventional-commits.mjs';

/** 新条目插入位置的锚点：写文件时据此定位，避免靠正则去猜正文结构。 */
const ENTRIES_ANCHOR = '<!-- changelog-entries -->';

/** 文件头（首次写入时创建）。声明「自动生成」以免有人手工改后被覆盖。 */
const FILE_HEADER = `# 变更日志

> 本文件**自动生成**，请勿手工编辑——手工改动会在下次生成时被覆盖。
> 数据来源：git 提交历史（[Conventional Commits](https://www.conventionalcommits.org/)）。
> 重新生成：\`npm run changelog:write -- --version <x.y.z>\`
> 分类规则与版本推进规则见 [AGENTS.md](AGENTS.md) 的「版本与发布」一节。

${ENTRIES_ANCHOR}

`;

/**
 * 解析参数。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{
 *   notes: boolean, write: boolean, selfTest: boolean,
 *   from: string|null, to: string, version: string|null,
 *   date: string|null, force: boolean, json: boolean,
 * }} 归一化后的选项。
 */
function parseArgs(argv) {
  const options = {
    notes: false,
    write: false,
    selfTest: false,
    from: null,
    to: 'HEAD',
    version: null,
    date: null,
    force: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--notes' || arg === '--release-notes') options.notes = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--from') options.from = next();
    else if (arg === '--to') options.to = next();
    else if (arg === '--version') options.version = next();
    else if (arg === '--date') options.date = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}（--help 查看用法）`);
  }
  return options;
}

const USAGE = `changelog.mjs — 从提交历史生成变更日志

  --notes, --release-notes   打印 Release 正文到 stdout
  --write                    写入/追加 CHANGELOG.md
  --from <ref>               起始 ref（不含）；省略则取最近的 v* tag，无 tag 则从头
  --to <ref>                 结束 ref，默认 HEAD
  --version <x.y.z>          --write 时的段落标题（写入必须提供）
  --date <YYYY-MM-DD>        段落日期，默认今天
  --force                    同版本段落已存在时允许覆盖（默认报错）
  --self-test                渲染逻辑自测（不读 git）
  --help                     显示本帮助`;

/**
 * 取提交链接的 base URL（如 `https://github.com/owner/repo`）。
 *
 * 支持两种 remote 写法：`git@github.com:owner/repo.git` 与
 * `https://github.com/owner/repo.git`。取不到时返回 `null`，条目退化为不带链接
 * 的纯文本——**不猜**一个可能错误的 URL。
 *
 * @param {string} [cwd] - 仓库路径。
 * @returns {string|null} 仓库网页地址；无法判定时为 `null`。
 */
export function repoUrl(cwd = process.cwd()) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
    const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
    const https = /^https?:\/\/(.+?)(?:\.git)?$/.exec(remote);
    if (https) return `https://${https[1]}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * 渲染单条提交为 Markdown 列表项。
 *
 * @param {object} commit - `parseCommit` 的产物。
 * @param {string|null} base - 仓库网页地址（用于生成链接）。
 * @returns {string} 形如 `- **shell**: 描述 ([476a056](https://…/commit/476a056))`。
 */
export function renderEntry(commit, base) {
  const scope = commit.scope ? `**${commit.scope}**: ` : '';
  // 非规范提交没有 type，原文照登——读者至少能看到「有这条改动」。
  const link = base ? ` ([${commit.shortSha}](${base}/commit/${commit.sha}))` : ` (${commit.shortSha})`;
  return `- ${scope}${commit.description}${link}`;
}

/**
 * 渲染一段完整的变更章节（破坏性置顶 + 各类型分组）。
 *
 * @param {Array<object>} commits - 已解析的提交。
 * @param {object} [options]
 * @param {string|null} [options.base] - 仓库网页地址。
 * @param {string|null} [options.heading] - 段落标题，如 `## [0.2.0] - 2026-09-11`；`null` 表示不渲染标题（Release 正文用）。
 * @param {number} [options.level] - 章节标题层级，默认 `###`。
 * @returns {string} Markdown 文本；无有效提交时返回空字符串。
 */
export function renderSection(commits, options = {}) {
  const { base = null, heading = null, level = '###' } = options;
  if (commits.length === 0) return '';

  const { breaking, sections } = classify(commits);
  const lines = [];
  if (heading) {
    lines.push(heading, '');
  }

  if (breaking.length > 0) {
    lines.push(`${level} ${BREAKING_TITLE}`, '');
    for (const commit of breaking) {
      lines.push(renderEntry(commit, base));
    }
    lines.push('');
  }

  for (const section of sections) {
    lines.push(`${level} ${section.title}`, '');
    for (const commit of section.commits) {
      lines.push(renderEntry(commit, base));
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 把新段落写入 CHANGELOG.md 的锚点之后。
 *
 * 三种情形：
 *   - 文件不存在 / 为空 → 用 `FILE_HEADER` 建新文件；
 *   - 同版本段落已存在且**未**给 `--force` → 报错（避免出现两段互不一致的同版本记录）；
 *   - 同版本段落已存在**且**给了 `--force` → **替换**那一段（这是「重新生成」的语义）。
 *
 * 第三种情形必须真的替换而不是再插一份：`--force` 若只是跳过重复检查，文件里
 * 就会出现同一版本的两段记录，读者无从判断以哪段为准——比直接报错更糟。
 *
 * @param {string} existing - 现有文件内容（空字符串表示新建）。
 * @param {string} section - 待写入的段落 Markdown。
 * @param {string} version - 版本号，用于定位/检测既有段落。
 * @param {boolean} force - 允许覆盖同版本段落。
 * @returns {string} 新的文件内容。
 * @throws {Error} 同版本段落已存在且未指定 `--force`，或文件缺少锚点时抛出。
 */
export function insertSection(existing, section, version, force = false) {
  const body = existing && existing.trim() ? existing : FILE_HEADER;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^## \\[${escaped}\\]`, 'm');
  const hasSection = headingPattern.test(body);

  if (hasSection && !force) {
    throw new Error(`CHANGELOG.md 里已存在 ${version} 段落；确认要覆盖请加 --force（避免同版本出现两段互不一致的记录）`);
  }

  const anchorIndex = body.indexOf(ENTRIES_ANCHOR);
  if (anchorIndex === -1) {
    // 文件是我们生成的却没找到锚点——说明被人手工改过。明确报错，不猜测插入位置。
    throw new Error(`CHANGELOG.md 缺少锚点 ${ENTRIES_ANCHOR}，无法确定插入位置（文件可能被手工编辑过）`);
  }

  if (hasSection) {
    // 替换：从该版本标题起，到**下一个版本标题之前**为止；它是最后一段则到文件末尾。
    //
    // 注意不能拿锚点位置当结束边界：锚点在文件**顶部**、各版本段落全在它之后，
    // 用锚点作 end 会得到 end < start，结果把整段复制一遍而不是替换掉。
    const start = headingPattern.exec(body).index;
    const lineEnd = body.indexOf('\n', start);
    const afterHeading = lineEnd === -1 ? body.length : lineEnd + 1;
    const nextMatch = /^## \[/m.exec(body.slice(afterHeading));
    const end = nextMatch ? afterHeading + nextMatch.index : body.length;
    return normalize(`${body.slice(0, start)}${section.trimEnd()}\n${body.slice(end)}`);
  }

  const insertAt = anchorIndex + ENTRIES_ANCHOR.length;
  return normalize(`${body.slice(0, insertAt)}\n\n${section.trimEnd()}\n${body.slice(insertAt)}`);
}

/**
 * 统一空白：连续空行折叠为一行空行，去掉文件末尾多余空行，保留单个结尾换行。
 *
 * 两条写入路径（首次插入 / 覆盖替换）**必须**产出同样的空白形态，否则
 * 「生成一次」与「重新生成」之间就会产生纯空白 diff——而 `--force` 覆盖是
 * 发布流程的正常步骤（`version:bump --commit` 会走它），于是每次发布都会在
 * CHANGELOG.md 上留下无意义的改动行。`selfTest()` 里有断言钉着这一点。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 规范化后的文本。
 */
function normalize(text) {
  return `${text.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 渲染逻辑自测（不依赖 git 仓库与网络）。
 *
 * @returns {{ passed: number }} 通过项数。
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项（不早退，便于一次看全）。
 */
export function selfTest() {
  const failures = [];
  // 计数器而非手写常量：手写的「通过 N 项」会随断言增删悄悄失真，而一个失真的
  // 数字本身就是错误宣称（这正是本仓库在治理的那类问题）。
  let passed = 0;
  const check = (condition, message) => {
    passed += 1;
    if (!condition) failures.push(message);
  };
  const base = 'https://github.com/example/repo';
  const make = (subject, sha, body = '') => parseCommit({ sha: sha.repeat(40).slice(0, 40), subject, body });

  // 1) 破坏性变更必须排在各章节之前。
  const mixed = [make('fix: 普通修复', 'a'), make('feat!: 不兼容改动', 'b'), make('docs: 文档', 'c')];
  const rendered = renderSection(mixed, { base });
  const breakingIndex = rendered.indexOf(BREAKING_TITLE);
  const featIndex = rendered.indexOf('✨ 新功能');
  check(breakingIndex !== -1, '渲染：破坏性变更章节缺失');
  check(!(breakingIndex > featIndex && featIndex !== -1), '渲染：破坏性变更必须排在「新功能」之前');

  // 2) 条目必须带 scope 与提交链接（可追溯是变更日志的基本要求）。
  const scoped = renderSection([make('feat(shell): 有 scope', 'd')], { base });
  check(scoped.includes('**shell**: 有 scope'), '渲染：scope 未按 `**scope**: 描述` 渲染');
  check(scoped.includes(`${base}/commit/${'d'.repeat(40)}`), '渲染：缺少指向完整 sha 的链接');

  // 3) base 为 null 时必须退化为纯文本短 sha，而不是拼出 `undefined/commit/…`。
  const noBase = renderSection([make('fix: 无远端', 'e')], { base: null });
  check(!noBase.includes('undefined'), '渲染：取不到 repo URL 时不得拼出 undefined 链接');
  check(noBase.includes('(eeeeeee)'), '渲染：无 URL 时应显示短 sha');

  // 4) 空输入必须产出空串，而不是一个只有标题的空洞。
  check(renderSection([], { base }) === '', '渲染：无提交时必须返回空串');

  // 5) 非规范提交必须仍然出现在输出里（硬规则 1 在渲染层的体现）。
  check(renderSection([make('初始提交', 'f')], { base }).includes('初始提交'), '渲染：非规范提交被丢弃了');

  // 6) insertSection 的幂等与防护。
  const once = insertSection('', '## [0.2.0] - 2026-01-01\n\n### ✨ 新功能\n\n- x\n', '0.2.0');
  check(once.includes('## [0.2.0]'), '插入：段落未写入');
  let threw = false;
  try {
    insertSection(once, '## [0.2.0] - 2026-01-02\n', '0.2.0');
  } catch {
    threw = true;
  }
  check(threw, '插入：同版本重复写入必须报错（否则会出现两段互不一致的记录）');

  // 6b) --force 必须是**替换**而不是再插一份：否则文件里同一版本出现两段，
  //     读者无从判断以哪段为准——比直接报错更糟。
  const replaced = insertSection(once, '## [0.2.0] - 2026-01-02\n\n### ✨ 新功能\n\n- 改过的内容\n', '0.2.0', true);
  const occurrences = (replaced.match(/^## \[0\.2\.0\]/gm) || []).length;
  check(occurrences === 1, `插入：--force 覆盖后同版本标题应只出现 1 次，实际 ${occurrences} 次`);
  check(replaced.includes('改过的内容'), '插入：--force 未写入新内容');
  check(!replaced.includes('2026-01-01'), '插入：--force 未移除旧段落');

  // 6c) 覆盖时必须保住**其他**版本的段落。
  const twoVersions = insertSection(
    insertSection('', '## [0.1.0] - 2026-01-01\n\n- old\n', '0.1.0'),
    '## [0.2.0] - 2026-02-02\n\n- mid\n',
    '0.2.0',
  );
  const afterForce = insertSection(twoVersions, '## [0.2.0] - 2026-02-03\n\n- mid2\n', '0.2.0', true);
  check(afterForce.includes('## [0.1.0]'), '插入：--force 覆盖误删了其它版本段落');
  check(afterForce.includes('mid2'), '插入：--force 覆盖未生效');
  check((afterForce.match(/^## \[/gm) || []).length === 2, '插入：--force 覆盖后段落总数应为 2');

  // 7) 缺锚点必须报错——猜测插入位置会写坏文件。
  threw = false;
  try {
    insertSection('# 变更日志\n\n没有锚点\n', '## [0.3.0]\n', '0.3.0');
  } catch {
    threw = true;
  }
  check(threw, '插入：缺少锚点时必须报错而不是猜测位置');

  // 8) 新段落必须插在锚点之后（保证最新版本在最上面）。
  const withOlder = insertSection(FILE_HEADER + '## [0.1.0] - 2026-01-01\n\n- old\n', '## [0.2.0] - 2026-02-02\n\n- new\n', '0.2.0');
  check(withOlder.indexOf('## [0.2.0]') < withOlder.indexOf('## [0.1.0]'), '插入：新版本必须排在旧版本之前');

  // 9) 幂等：首次写入与「覆盖重写同一版本」必须逐字节相同。
  //
  // 这条守的是发布流程本身——`version:bump --commit` 走的就是覆盖路径，
  // 两条路径空白处理不一致的话，每次发布都会在 CHANGELOG.md 上留下纯空白 diff。
  const section = '## [0.2.0] - 2026-02-02\n\n### ✨ 新功能\n\n- new\n';
  const first = insertSection('', section, '0.2.0');
  const rewritten = insertSection(first, section, '0.2.0', true);
  check(first === rewritten, '插入：首次写入与覆盖重写的结果必须逐字节相同（否则每次发布都会产生纯空白 diff）');
  check(!/\n\n\n/.test(first), '插入：产出不得含连续空行');
  check(first.endsWith('\n') && !first.endsWith('\n\n'), '插入：文件应以单个换行结尾');

  if (failures.length > 0) {
    throw new Error(`changelog 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}

/**
 * CLI 主入口。
 *
 * @param {string[]} argv - 命令行参数。
 * @returns {Promise<void>}
 */
async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (options.selfTest) {
    const { passed } = selfTest();
    console.log(`✅ changelog 自测通过（${passed} 项）`);
    return;
  }

  // `--from` 省略时的默认基线：最近一个 v* tag；没有 tag 说明是首次发布，从头读。
  const from = options.from ?? latestTag();
  const commits = readCommits({ from, to: options.to });
  const base = repoUrl();

  if (options.json) {
    console.log(JSON.stringify({ from, to: options.to, count: commits.length, base }, null, 2));
    return;
  }

  if (commits.length === 0) {
    console.log(`（${from ? `${from}..${options.to}` : options.to} 区间内没有提交）`);
    return;
  }

  if (options.write) {
    if (!options.version) {
      throw new Error('--write 必须同时给 --version <x.y.z>：段落标题需要明确的版本号，不猜');
    }
    const date = options.date || new Date().toISOString().slice(0, 10);
    const section = renderSection(commits, { base, heading: `## [${options.version}] - ${date}` });
    const file = path.resolve('CHANGELOG.md');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = insertSection(existing, section, options.version, options.force);
    writeFileSync(file, next, 'utf8');
    console.log(`✅ 已写入 CHANGELOG.md（版本 ${options.version}，${commits.length} 条提交）`);
    return;
  }

  // 默认行为（含 --notes）：打印正文。
  console.log(renderSection(commits, { base }));
}
