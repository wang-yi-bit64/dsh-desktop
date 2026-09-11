#!/usr/bin/env node
/**
 * conventional-commits.mjs — Conventional Commits 解析器（共享库 + 自测）
 *
 * ## 为什么存在
 *
 * 本仓库的「变更历史」「版本号推进」两件事**必须基于同一份事实**：提交历史。
 * 如果各写一份解析逻辑，就会退化成人肉纪律——`version.mjs` 认为「有 feat 该出
 * minor」，而 `changelog.mjs` 把同一条提交归进了「其他」，两边对同一个版本给出
 * 两种说法。因此解析、归类、版本建议三件事都收在这里，被两个 CLI 复用。
 *
 * 不加第三方依赖（如 `conventional-changelog` / `git-cliff`）的理由：本仓库的
 * 门禁脚本一律自包含且可 `--self-test`（见 `AGENTS.md` §2）。解析规则是我们自己的
 * 约定，放在仓库里才能被测试、被 diff、被审计。
 *
 * ## 归类的两条硬规则
 *
 * 1. **不静默丢弃任何提交。** 认不出 `type` 的提交（本仓库真实存在：`debug(ci):`）
 *    归入「其他」并**保留原始 type 文案**。静默丢弃会让变更日志「因遗漏而撒谎」——
 *    这比分类不准严重得多。
 * 2. **破坏性变更单独置顶**，且原始 type 的归类不变（一条 `feat!:` 既出现在
 *    「破坏性变更」，也出现在「新功能」）。
 *
 * ## 用法
 *
 * 作为库：
 * ```js
 * import { readCommits, classify, suggestBump } from './conventional-commits.mjs';
 * ```
 *
 * 自测（无 git 依赖，纯逻辑）：
 * ```bash
 * node scripts/conventional-commits.mjs --self-test
 * ```
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 章节定义：顺序即渲染顺序，`title` 直接进 Markdown 标题。
 *
 * `types` 里的 type 全部落入该章节；未列出的 type 进「其他」。
 * 顺序刻意按「读者关心程度」排：破坏性 → 功能 → 修复 → 性能 → 重构 → 其余。
 */
export const SECTIONS = [
  { key: 'feat', title: '✨ 新功能', types: ['feat'] },
  { key: 'fix', title: '🐛 修复', types: ['fix'] },
  { key: 'perf', title: '⚡ 性能', types: ['perf'] },
  { key: 'refactor', title: '♻️ 重构', types: ['refactor'] },
  { key: 'docs', title: '📝 文档', types: ['docs'] },
  { key: 'test', title: '✅ 测试', types: ['test'] },
  { key: 'build', title: '📦 构建与打包', types: ['build'] },
  { key: 'ci', title: '🔧 CI', types: ['ci'] },
  { key: 'other', title: '🧹 其他', types: ['chore', 'style', 'revert'] },
];

/** 破坏性变更章节的标题（单独置顶）。 */
export const BREAKING_TITLE = '⚠️ 破坏性变更';

/** 自定义 type → 章节 key 的查找表（由 SECTIONS 展开，避免两处维护）。 */
const TYPE_TO_SECTION = new Map(
  SECTIONS.flatMap((section) => section.types.map((type) => [type, section.key])),
);

/**
 * 解析单条提交。
 *
 * @param {{ sha: string, subject: string, body?: string }} raw - 来自 `git log` 的原始三元组。
 * @returns {{
 *   sha: string,
 *   shortSha: string,
 *   type: string|null,
 *   scope: string|null,
 *   description: string,
 *   breaking: boolean,
 *   conventional: boolean,
 *   rawType: string|null,
 * }} 解析结果；`type === null` 表示不是规范提交，`rawType` 保留原始 type 文案。
 */
export function parseCommit(raw) {
  const subject = (raw.subject || '').trim();
  const body = raw.body || '';
  const shortSha = raw.sha.slice(0, 7);

  // type(scope)!: description —— scope 与 ! 都可选。
  // 注意 `[^)]*` 不允许 scope 内含 `)`，这与 Conventional Commits 一致。
  const match = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s+(?<desc>.+)$/.exec(subject);

  if (!match) {
    // 非规范提交（如更名、合并、手写句子）。**不丢弃**，原样进「其他」。
    return {
      sha: raw.sha,
      shortSha,
      type: null,
      scope: null,
      description: subject,
      breaking: isBreakingFooter(body),
      conventional: false,
      rawType: null,
    };
  }

  const { type, scope, bang, desc } = match.groups;
  return {
    sha: raw.sha,
    shortSha,
    type,
    scope: scope || null,
    description: desc.trim(),
    // 破坏性有两种声明方式：主题里的 `!`，或正文里的 `BREAKING CHANGE:` 页脚。
    breaking: Boolean(bang) || isBreakingFooter(body),
    conventional: true,
    rawType: type,
  };
}

/**
 * 判断正文是否含破坏性变更页脚（`BREAKING CHANGE:` / `BREAKING-CHANGE:`）。
 *
 * @param {string} body - 提交正文。
 * @returns {boolean} 命中任一写法即为 `true`。
 */
function isBreakingFooter(body) {
  return /^BREAKING[ -]CHANGE:/m.test(body);
}

/**
 * 把提交列表归类为章节。
 *
 * 破坏性变更**同时**出现在置顶章节与其按 type 归类的章节里——读者既要知道
 * 「有破坏性变更」，也要知道它属于哪一类工作。
 *
 * @param {Array<ReturnType<typeof parseCommit>>} commits - 已解析的提交。
 * @returns {{
 *   breaking: Array<object>,
 *   sections: Array<{ key: string, title: string, commits: Array<object> }>,
 *   total: number,
 * }} 归类结果；空章节不出现在 `sections` 里（避免出现只有标题的空洞）。
 */
export function classify(commits) {
  const breaking = commits.filter((commit) => commit.breaking);

  const sections = SECTIONS.map((section) => ({
    key: section.key,
    title: section.title,
    // 「其他」章节额外收留所有认不出的 type 与非规范提交。
    //
    // 注意 `?? 'other'` 这个兜底不能省：`TYPE_TO_SECTION.get('debug')` 返回
    // `undefined`，若直接与章节 key 比较，未知 type 会因为「不等于任何 key」
    // 而掉进所有章节之外——提交就此从变更日志里消失。这是本模块硬规则 1 的
    // 落点，`selfTest()` 里有断言钉着。
    commits: commits.filter((commit) => {
      if (commit.type === null) return section.key === 'other';
      return (TYPE_TO_SECTION.get(commit.type) ?? 'other') === section.key;
    }),
  })).filter((section) => section.commits.length > 0);

  return { breaking, sections, total: commits.length };
}

/**
 * 依据提交内容建议下一个版本号该升哪一位。
 *
 * 规则（与 Conventional Commits 的语义对齐，也是 `AGENTS.md` 里写明的对外约定）：
 *
 * | 条件 | 建议 | 理由 |
 * |------|------|------|
 * | 任一破坏性变更 | `major` | 调用方需要改代码 |
 * | 任一 `feat` | `minor` | 向后兼容地新增能力 |
 * | 任一 `fix` / `perf` | `patch` | 向后兼容地修缺陷 / 提速 |
 * | 只有 `docs` / `chore` / `ci` … | `none` | **不发版**：产物没有任何行为变化 |
 *
 * `none` 是刻意返回的：把「只有文档改动」也发一个 patch 版，会让版本号失去
 * 「产物变了」的含义，用户逐渐忽略更新提示。
 *
 * @param {Array<ReturnType<typeof parseCommit>>} commits - 已解析的提交。
 * @returns {'major'|'minor'|'patch'|'none'} 建议的升级位。
 */
export function suggestBump(commits) {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  if (commits.some((commit) => commit.type === 'fix' || commit.type === 'perf')) return 'patch';
  return 'none';
}

/**
 * 从 git 历史读取并解析提交。
 *
 * 用 `%x1f`（单元分隔符）/ `%x1e`（记录分隔符）做字段与记录边界，而不是换行——
 * 提交正文里换行是常态，用换行切分必然把正文切开。
 *
 * @param {object} [options]
 * @param {string|null} [options.from] - 起始 ref（**不含**）；为 `null` 时从头读。
 * @param {string} [options.to] - 结束 ref，默认 `HEAD`。
 * @param {string} [options.cwd] - 仓库路径，默认当前工作目录。
 * @param {string} [options.range] - 显式区间（形如 `a..b`），优先于 `from`/`to`。
 * @returns {Array<ReturnType<typeof parseCommit>>} 按时间倒序排列的已解析提交。
 * @throws {Error} 当 `git` 不可用或 ref 不存在时抛出，并带上 stderr 便于归因。
 */
export function readCommits(options = {}) {
  const { from = null, to = 'HEAD', cwd = process.cwd(), range } = options;
  const revRange = range || (from ? `${from}..${to}` : to);
  const format = '%H%x1f%s%x1f%b%x1e';

  let stdout;
  try {
    stdout = execFileSync('git', ['log', `--format=${format}`, revRange], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    throw new Error(`git log ${revRange} 失败：${detail}`);
  }

  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body] = record.split('\x1f');
      return parseCommit({ sha: (sha || '').trim(), subject, body });
    })
    .filter((commit) => commit.sha);
}

/**
 * 读取仓库中「指定起点可达」的最近 tag（按版本序，非字典序）。
 *
 * `rev` 决定了搜索范围：省略时从 `HEAD` 起（= 「目前最新的 tag」）；给出时从该
 * rev 起。**这个参数不是可选便利，而是正确性所必需**——见 `baselineRefFor()`：
 * 想知道「某个 tag 的上一个 tag」，只能从 `tag^` 去找；从 `HEAD` 找会把该 tag
 * 自己找回来，区间随之退化成空。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - 仓库路径。
 * @param {string} [options.pattern] - tag 匹配模式，默认 `v*`。
 * @param {string} [options.rev] - 起始 revision，默认 `HEAD`。
 * @returns {string|null} 最近 tag 名；范围内无 tag 时返回 `null`（**首次发布**的情形）。
 */
export function latestTag(options = {}) {
  const { cwd = process.cwd(), pattern = 'v*', rev } = options;
  const args = ['describe', '--tags', '--abbrev=0', `--match=${pattern}`];
  if (rev) args.push(rev);
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // stderr 必须丢弃：没有 tag 时 git 会打印 `fatal: No names found…`。
      // 那是**合法状态**（首次发布），泄漏到 CI 日志里会被读成构建失败。
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim() || null;
  } catch {
    // `git describe` 在没有匹配 tag 时以非零码退出——这是合法状态，不是错误。
    // `rev` 非法（如根提交的 `^`）同样走这里，语义退化为「从头读」，也是安全的。
    return null;
  }
}

/**
 * 求「相对 `to` 的上一个 tag」应当从哪个 revision 开始搜索。
 *
 * 这是变更日志最容易错、且错了**不会报错只会变空**的一处：
 * 生成 `v0.1.0` 的说明时，若从 `HEAD`（或任何包含 `v0.1.0` 的起点）去找最近的
 * tag，找回来的正是 `v0.1.0` 自己，`--from` 与 `--to` 指向同一个提交，区间为空，
 * Release 正文就成了「区间内没有提交」。发布链路里这个 tag 在生成说明时**必然
 * 已经存在**（它是 push 上来的），所以这不是理论边界，而是首次发布的默认路径。
 *
 * @param {string|null|undefined} to - 区间的结束 ref；省略表示 `HEAD`。
 * @returns {string|null} 传给 `latestTag` 的 rev；`null` 表示按 `HEAD` 搜索。
 */
export function baselineRefFor(to) {
  return to ? `${to}^` : null;
}

// ---------------------------------------------------------------------------
// 自测：不依赖 git 仓库，纯逻辑断言（与 `verify-target.mjs --self-test` 同一风格）
// ---------------------------------------------------------------------------

/** 自测用的固定样本，覆盖每一种分支。 */
const SELF_TEST_FIXTURES = [
  { label: 'feat 带 scope', raw: { sha: 'a'.repeat(40), subject: 'feat(shell): 新增注入机制', body: '' }, expect: { type: 'feat', scope: 'shell', breaking: false } },
  { label: 'fix 无 scope', raw: { sha: 'b'.repeat(40), subject: 'fix: 修复静默失效', body: '' }, expect: { type: 'fix', scope: null, breaking: false } },
  { label: '叹号破坏性', raw: { sha: 'c'.repeat(40), subject: 'feat(api)!: 移除 v1 端点', body: '' }, expect: { type: 'feat', scope: 'api', breaking: true } },
  { label: '页脚破坏性', raw: { sha: 'd'.repeat(40), subject: 'fix: 调整默认值', body: '正文\n\nBREAKING CHANGE: 默认值改为 false' }, expect: { type: 'fix', breaking: true } },
  { label: '连字符页脚破坏性', raw: { sha: 'e'.repeat(40), subject: 'fix: 调整默认值', body: 'BREAKING-CHANGE: 同上' }, expect: { type: 'fix', breaking: true } },
  { label: '未知 type（本仓库真实存在）', raw: { sha: 'f'.repeat(40), subject: 'debug(ci): 临时输出诊断', body: '' }, expect: { type: 'debug', conventional: true } },
  { label: '非规范提交', raw: { sha: '1'.repeat(40), subject: '初始提交', body: '' }, expect: { type: null, conventional: false } },
  { label: '非 ASCII 正文不误判', raw: { sha: '2'.repeat(40), subject: 'docs: 说明 BREAKING CHANGE 的含义', body: '这里只是解释，不是页脚' }, expect: { type: 'docs', breaking: false } },
];

/**
 * 运行自测。失败时抛错（进程以非零码退出），成功则打印通过项数。
 *
 * @returns {{ passed: number, failed: number }} 统计。
 */
export function selfTest() {
  const failures = [];

  for (const fixture of SELF_TEST_FIXTURES) {
    const parsed = parseCommit(fixture.raw);
    for (const [key, expected] of Object.entries(fixture.expect)) {
      if (parsed[key] !== expected) {
        failures.push(`${fixture.label}：字段 ${key} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(parsed[key])}`);
      }
    }
  }

  // 归类：认不出的 type 必须**进「其他」而不是消失**——这是本模块的硬规则 1。
  const unknownType = parseCommit({ sha: '3'.repeat(40), subject: 'debug(ci): 定位跨平台失败', body: '' });
  const { sections } = classify([unknownType]);
  const other = sections.find((section) => section.key === 'other');
  if (!other || other.commits.length !== 1) {
    failures.push('归类：未知 type（debug）必须落入「其他」章节，实际未落入——静默丢弃会让变更日志因遗漏而撒谎');
  }

  // 归类：破坏性提交必须**同时**出现在置顶章节与它的 type 章节。
  const breakingFeat = parseCommit({ sha: '4'.repeat(40), subject: 'feat(api)!: 移除 v1', body: '' });
  const breakingResult = classify([breakingFeat]);
  if (breakingResult.breaking.length !== 1) {
    failures.push('归类：破坏性提交必须出现在置顶章节');
  }
  const featSection = breakingResult.sections.find((section) => section.key === 'feat');
  if (!featSection || featSection.commits.length !== 1) {
    failures.push('归类：破坏性提交仍须按 type 出现在「新功能」章节（两处都要有）');
  }

  // 空章节不得出现（避免渲染出只有标题的空洞）。
  const onlyFix = classify([parseCommit({ sha: '5'.repeat(40), subject: 'fix: 修一下', body: '' })]);
  if (onlyFix.sections.some((section) => section.key === 'feat')) {
    failures.push('归类：没有 feat 时不得产出空的「新功能」章节');
  }

  // 版本建议的四种情形。
  const bumpCases = [
    { label: '破坏性 → major', subject: 'feat!: 不兼容改动', want: 'major' },
    { label: 'feat → minor', subject: 'feat: 新功能', want: 'minor' },
    { label: 'fix → patch', subject: 'fix: 修缺陷', want: 'patch' },
    { label: 'docs → none', subject: 'docs: 改文档', want: 'none' },
    { label: 'chore → none', subject: 'chore: 杂务', want: 'none' },
    { label: 'fix+feat 混合 → minor', subject: null, want: 'minor', mix: ['fix: a', 'feat: b'] },
  ];
  for (const testCase of bumpCases) {
    const commits = (testCase.mix || [testCase.subject]).map((subject, index) =>
      parseCommit({ sha: `${index}`.repeat(40).slice(0, 40), subject, body: '' }),
    );
    const got = suggestBump(commits);
    if (got !== testCase.want) {
      failures.push(`版本建议：${testCase.label} 期望 ${testCase.want}，实际 ${got}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`conventional-commits 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed: SELF_TEST_FIXTURES.length + 3 + bumpCases.length, failed: 0 };
}

// 直接执行时支持 --self-test；作为库 import 时不触发任何副作用。
//
// 判定「是不是直接执行」用 realpath 比较：Windows 下 `process.argv[1]` 是
// 反斜杠路径而 `import.meta.url` 是 file:// URL，直接比字符串会漏判，
// 导致 `node scripts/xxx.mjs --self-test` 静默什么都不做——那比报错更糟。
const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    try {
      const { passed } = selfTest();
      console.log(`✅ conventional-commits 自测通过（${passed} 项）`);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error('用法：node scripts/conventional-commits.mjs --self-test');
    process.exit(2);
  }
}
