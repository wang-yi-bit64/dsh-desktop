#!/usr/bin/env node
/**
 * upstream-release.mjs — 上游 DSH **发布面**（GitHub Release）的唯一产地。
 *
 * ## 为什么需要它（计划 2f）
 *
 * 上游 `@deepseek-ai/dsh` 的版本信息有两个来源，**它们不是同一件事**：
 *
 * | 来源 | 是什么 | 什么时候动 |
 * |---|---|---|
 * | npm dist-tag（`latest` / `next` / `alpha`） | 上游**包分发**指向哪一版 | 发布流程走到「发 npm」那一步才动 |
 * | GitHub Release（`deepseek-ai/deepseek-harness`） | 上游**宣布发了哪一版** | tag 一打就有 |
 *
 * 实测（2026-10-09）：两者可以不一致——上游 Release 已到 `dsh-v0.2.1-alpha.1`，
 * 而 npm `next` 还停在 `0.2.0-rc.2`。更早的实测还出现过「tag 已动、依赖树未齐」的波次。
 * ⇒ 「上游走到哪了」这件事，**Release 比 dist-tag 更早可见**，这才是漂移哨兵该看的基准。
 *
 * ## 🔴 四条实测事实（每一条都能让天真实现静默出错）
 *
 * 1. **tag 形态是 `dsh-v<x.y.z>`**，不是 `v<x.y.z>`。
 *    `gh api repos/<slug>/releases/tags/v0.2.1-alpha.1` ⇒ **404**；
 *    `.../releases/tags/dsh-v0.2.1-alpha.1` ⇒ 命中。
 *    （该缺陷曾真实存在于 `sync-upstream-release.mjs` 的步骤①② —— 因为它当时**从未被执行过**。）
 *
 * 2. **`/releases/latest` 对本上游返回 404。** 该端点的定义是「最新**非**预发布 Release」，
 *    而上游**全部** 25 个 Release 都是 `prerelease: true` ⇒ 永远 404。
 *    ⇒ 必须**列清单 + 按 semver 取最大**，不能指望端点替你选。
 *
 * 3. **`target_commitish` 通常是分支名，不是 commit。**
 *    实测 25 条里绝大多数是字符串 `master`（少数是 40 位 SHA）。
 *    ⇒ 「步骤② 取上游 commit」**必须另走 `commits/<ref>` 解析**；直接抄 `target_commitish`
 *    会把一个分支名写进台账的 `upstreamCommit`（= 伪造一个不存在的 commit 身份）。
 *
 * 4. **`gh` 调用不要加 `shell: true`。** Windows 上 `shell: true` 会把 argv 拼成一行再交给
 *    `cmd.exe` 重新切分 ⇒ 含空格/花括号的参数（如 `--jq '{tag: .tag_name}'`）被**拆成多个参数**，
 *    报错形态还是「Release 不存在」。`CreateProcess` 自身会补 `.exe`，所以裸 `gh` 不需要 shell。
 *    （`npm` 是 `.cmd`，**仍然**需要 `shell: true` —— 两者纪律不同，别互相照抄。）
 *
 * ## 离线/异常一律**显式**，不许静默
 *
 * `fetchUpstreamReleases` 返回四态，**刻意不合并**：
 *
 * | status | 含义 | 调用方该做什么 |
 * |---|---|---|
 * | `ok` | 取到可用 Release | 正常比较 |
 * | `empty` | 仓库可达，但一条可用的都没有（全 draft / 全是别的 tag 形态） | SKIP **并报出被排除的条数与原因**（否则与「真没有漂移」长得一样） |
 * | `skip` | 取不到（`gh` 缺失 / 网络不可达 / 限流） | SKIP 并说明「未核对」 |
 * | `error` | 响应**不该长这样**（404 说明 slug 错了、JSON 不可解析） | **判红**——这是配置缺陷，不是外部状态 |
 *
 * `error` 与 `skip` 必须分开：slug 是本仓写死的常量，它 404 意味着**我们**错了；
 * 把它当 SKIP 会让一个配置错误永远隐身（本仓纪律：不可判定与配置错误不是一回事）。
 *
 * ## CLI
 *
 * ```bash
 * node scripts/upstream-release.mjs --self-test   # 纯逻辑自测（不联网）
 * node scripts/upstream-release.mjs               # 真查一次并打印（排障用）
 * ```
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 上游仓库 slug（**唯一产地**）。
 * 实测 2026-10-09：`default_branch = master`、`archived = false`、`repository.directory = apps/cli`。
 * ⚠️ 本仓**没有**第二个地方写它——`sync-upstream-release.mjs` 与漂移哨兵都从这里取。
 */
export const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';

/**
 * Release tag 前缀（**唯一产地**）。上游用 `dsh-v`，不是 `v`。
 * 见文件头事实 1。
 */
export const UPSTREAM_TAG_PREFIX = 'dsh-v';

/** 单次取回的 Release 条数（GitHub 上限 100；实测上游共 25 条）。 */
export const RELEASES_PER_PAGE = 100;

/** 版本字符串的形状（够用即可，不追求 semver 全集）。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 上游精确版本 → 上游 Release tag。
 *
 * 这个函数存在的唯一理由是让那个**已发生过的**字符串拼接缺陷无法复现：
 * 调用方再也拿不到「自己拼 tag」的机会。
 *
 * @param {string} version - 上游精确版本，如 `0.2.1-alpha.1`。
 * @returns {string} 如 `dsh-v0.2.1-alpha.1`。
 * @throws {Error} 版本为空或不是 `<x.y.z>[ -<预发布>]` 形态时——拼出来的 tag 会去查一个
 *   不存在的 Release，而报错形态是「上游没有这个 Release」，看起来像上游的问题。
 */
export function tagForVersion(version) {
  const raw = String(version ?? '').trim();
  if (raw === '') {
    throw new Error('上游版本为空：tag 由它拼出，不能凭空造（形态见本文件头事实 1）');
  }
  if (!VERSION_PATTERN.test(raw)) {
    throw new Error(
      `上游版本 ${JSON.stringify(raw)} 不是 <x.y.z> 或 <x.y.z>-<预发布> 形态——` +
        `tag 由它拼出；形状不对会让「Release 不存在」的假红看起来像上游的问题。`,
    );
  }
  return `${UPSTREAM_TAG_PREFIX}${raw}`;
}

/**
 * 上游 Release tag → 上游精确版本。**不匹配就返回 `null`，不猜**。
 *
 * @param {string} tag - 如 `dsh-v0.2.1-alpha.1`。
 * @returns {string|null} 如 `0.2.1-alpha.1`；`v0.2.1-alpha.1`（缺前缀）等形态返回 `null`。
 */
export function versionFromTag(tag) {
  const raw = String(tag ?? '').trim();
  if (!raw.startsWith(UPSTREAM_TAG_PREFIX)) return null;
  const version = raw.slice(UPSTREAM_TAG_PREFIX.length);
  return VERSION_PATTERN.test(version) ? version : null;
}

/**
 * `gh api` 的路径（含分页）。
 *
 * @param {string} [repo] - `owner/name`。
 * @param {number} [perPage] - 每页条数。
 * @returns {string} 如 `repos/deepseek-ai/deepseek-harness/releases?per_page=100`。
 * @throws {Error} slug 不是 `owner/name` 形态时——错误越早越便宜。
 */
export function releasesApiPath(repo = UPSTREAM_REPO, perPage = RELEASES_PER_PAGE) {
  const slug = String(repo ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`上游仓库 slug 必须是 owner/name，收到 ${JSON.stringify(repo)}`);
  }
  return `repos/${slug}/releases?per_page=${perPage}`;
}

/**
 * 把 API 原始清单规范化，并**如实报告被排除的条目**。
 *
 * 为什么必须报告 `ignored`：若哪天上游改了 tag 形态（比如去掉 `dsh-`），
 * 过滤后 `releases` 会变成空数组。空数组与「上游确实没有漂移」在下游看起来一样——
 * 「扫描器坏了」与「真的没有东西」长得一模一样是本仓已踩过多次的形态。
 * ⇒ 排除原因必须显式带出来，由调用方在 SKIP 里点名。
 *
 * @param {unknown} raw - `gh api .../releases` 解析出的数组。
 * @returns {{releases: object[], ignored: {tag: string, why: string}[]}}
 *   `releases[]`：`{ tag, version, prerelease, publishedAt, commitish }`。
 */
export function normalizeReleases(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const releases = [];
  const ignored = [];
  for (const item of list) {
    const tag = String(item?.tag_name ?? '').trim();
    if (tag === '') {
      ignored.push({ tag: '(无 tag_name)', why: '条目缺 tag_name' });
      continue;
    }
    if (item?.draft === true) {
      // draft 未发布 ⇒ 用户拿不到它，不构成「上游已交付」
      ignored.push({ tag, why: 'draft（未发布）' });
      continue;
    }
    const version = versionFromTag(tag);
    if (version === null) {
      ignored.push({ tag, why: `tag 不匹配 ${UPSTREAM_TAG_PREFIX}<x.y.z> 形态` });
      continue;
    }
    releases.push({
      tag,
      version,
      prerelease: item?.prerelease === true,
      publishedAt: typeof item?.published_at === 'string' ? item.published_at : null,
      commitish: typeof item?.target_commitish === 'string' ? item.target_commitish : null,
    });
  }
  return { releases, ignored };
}

/**
 * 取**最新**的一条 Release。
 *
 * 为什么不用 `gh api .../releases/latest`：见文件头事实 2——该端点只看非预发布 Release，
 * 对全 prerelease 的上游恒 404。
 *
 * 比较器**必须显式传入**（不给默认值）：排序口径是调用方的语义（漂移哨兵要区分
 * 预发布阶段、而取最大值只需普通 semver），一个隐藏的默认比较器会让两处口径悄悄分家。
 *
 * @param {object[]} releases - {@link normalizeReleases} 的 `releases`。
 * @param {(a: string, b: string) => number} compare - 版本比较器（`a < b` 返回负数）。
 * @returns {object|null} 最新那条；空清单返回 `null`。
 * @throws {Error} 没给比较器时。
 */
export function pickNewestRelease(releases, compare) {
  if (typeof compare !== 'function') {
    throw new Error('pickNewestRelease 需要显式比较器：排序口径不许用默认值猜');
  }
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (best === null || compare(release.version, best.version) > 0) best = release;
  }
  return best;
}

/**
 * 默认子进程调用器 —— **本文件唯一一份**，别在别处再内联写一遍。
 *
 * ⚠️ `stdio: ['ignore', …]` 不是风格问题：Windows 上默认的 `stdin: 'pipe'` 会让 spawn
 * 直接失败（`EBUSY`），而失败外表是「取不到上游 Release」——本仓据此误诊过两个月。
 * `gh api` 不读 stdin，语义等价。
 *
 * ⚠️ **不加 `shell`**：见文件头事实 4。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string, error: NodeJS.ErrnoException|null}}
 */
export function spawnRunner(cmd, args) {
  const out = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: out.status ?? 1,
    stdout: out.stdout ?? '',
    stderr: out.stderr ?? '',
    error: out.error ?? null,
  };
}

/**
 * 取上游 Release 清单。**任何情形都有返回值，不抛异常**（四态见文件头）。
 *
 * @param {object} [options]
 * @param {string} [options.repo] - `owner/name`；缺省 {@link UPSTREAM_REPO}。
 * @param {number} [options.perPage] - 每页条数。
 * @param {(cmd: string, args: string[]) => object} [options.runner] - 子进程调用器（自测注入）。
 * @returns {{status:'ok', releases: object[], ignored: object[]}
 *   | {status:'empty', releases: object[], ignored: object[], reason: string}
 *   | {status:'skip', reason: string}
 *   | {status:'error', reason: string}}
 */
export function fetchUpstreamReleases({ repo = UPSTREAM_REPO, perPage = RELEASES_PER_PAGE, runner = spawnRunner } = {}) {
  const run = runner ?? spawnRunner;
  const result = run('gh', ['api', releasesApiPath(repo, perPage)]);
  const stderr = String(result.stderr ?? '');
  const stdout = String(result.stdout ?? '');

  if (result.status !== 0) {
    const firstLine = (stderr || stdout).trim().split(/\r?\n/)[0] || `gh 退出码 ${result.status}`;
    // `gh` 本身不存在 ⇒ 工具链缺失，属外部状态 ⇒ SKIP（并写清理由，不许静默）。
    if (result.error?.code === 'ENOENT') {
      return { status: 'skip', reason: `未找到 gh 命令（无法查询上游 Release）：${firstLine}` };
    }
    // 404 ⇒ slug 错了 / 仓库被改名或转私有。这是我们自己的配置缺陷，**不是**外部状态。
    if (/HTTP 404|Not Found/i.test(stderr + stdout)) {
      return {
        status: 'error',
        reason:
          `上游仓库 ${repo} 返回 404：slug 是本仓写死的常量（upstream-release.mjs 的 UPSTREAM_REPO）` +
          `⇒ 要么写错了、要么仓库改名/转私有。这是配置缺陷而不是「取不到」，故判红。原始信息：${firstLine}`,
      };
    }
    return { status: 'skip', reason: `gh api 取不到上游 Release：${firstLine}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return { status: 'error', reason: `gh api 响应不是合法 JSON：${error.message}（前 120 字：${stdout.slice(0, 120)}）` };
  }
  if (!Array.isArray(parsed)) {
    return { status: 'error', reason: `gh api 响应不是数组（收到 ${typeof parsed}）——端点路径写错了？` };
  }

  const { releases, ignored } = normalizeReleases(parsed);
  if (releases.length === 0) {
    // 「一条可用的都没有」绝不能冒充「没有漂移」：把排除原因带出来。
    const sample = ignored.slice(0, 3).map((entry) => `${entry.tag}（${entry.why}）`).join('；');
    return {
      status: 'empty',
      releases: [],
      ignored,
      reason:
        ignored.length === 0
          ? `${repo} 上一条 Release 都没有（该仓库可能还没发过）`
          : `${repo} 上 ${parsed.length} 条 Release 里 ${ignored.length} 条被排除，没有可用基准。样例：${sample}`,
    };
  }
  return { status: 'ok', releases, ignored };
}

/**
 * 取**某一条** tag 的 Release（`sync-upstream-release.mjs` 的步骤①用它）。
 *
 * 与 {@link fetchUpstreamReleases} 的分工：那个回答「上游走到哪了」（基准），
 * 这个回答「我要发的这一版上游到底发了没有」（准入）。
 *
 * @param {object} input
 * @param {string} input.tag - 上游 tag（`dsh-v…`）。
 * @param {string} [input.repo] - `owner/name`。
 * @param {(cmd: string, args: string[]) => object} [input.runner] - 子进程调用器。
 * @returns {{status:'ok', release: object} | {status:'failed', detail: string}}
 *   `release`：`{ tag, version, draft, prerelease, publishedAt, commitish }`。
 */
export function fetchUpstreamReleaseByTag({ tag, repo = UPSTREAM_REPO, runner = spawnRunner }) {
  const rawTag = String(tag ?? '').trim();
  if (rawTag === '') return { status: 'failed', detail: 'tag 为空：无从查起' };
  const run = runner ?? spawnRunner;
  const result = run('gh', ['api', `repos/${repo}/releases/tags/${rawTag}`]);
  const stderr = String(result.stderr ?? '');
  const stdout = String(result.stdout ?? '');
  if (result.status !== 0) {
    const firstLine = (stderr || stdout).trim().split(/\r?\n/)[0] || `gh 退出码 ${result.status}`;
    return { status: 'failed', detail: `${repo} 没有 Release ${JSON.stringify(rawTag)}：${firstLine}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return { status: 'failed', detail: `Release ${rawTag} 的响应不可解析：${error.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'failed', detail: `Release ${rawTag} 的响应不是对象（收到 ${typeof parsed}）` };
  }
  // 按 tag 查却回了一个**别的** tag ⇒ 端点行为异常。当成功会让下游拿到错版本的元数据。
  const tagName = String(parsed.tag_name ?? '').trim();
  if (tagName !== rawTag) {
    return {
      status: 'failed',
      detail: `请求 tag ${JSON.stringify(rawTag)}，响应里的 tag_name 却是 ${JSON.stringify(tagName)}——不拿它当成功`,
    };
  }
  const version = versionFromTag(tagName);
  if (version === null) {
    return { status: 'failed', detail: `Release tag ${tagName} 不匹配 ${UPSTREAM_TAG_PREFIX}<x.y.z> 形态` };
  }
  return {
    status: 'ok',
    release: {
      tag: tagName,
      version,
      draft: parsed.draft === true,
      prerelease: parsed.prerelease === true,
      publishedAt: typeof parsed.published_at === 'string' ? parsed.published_at : null,
      // ⚠️ 多数情况下这是**分支名**（实测 `master`），不是 commit。见文件头事实 3。
      commitish: typeof parsed.target_commitish === 'string' ? parsed.target_commitish : null,
    },
  };
}

/**
 * 取某条 tag 的**真实 commit SHA**。
 *
 * 为什么必须单独一步：`Release.target_commitish` 实测多数是分支名 `master`，
 * 直接把它当 commit 记进台账 = 伪造一个不存在的 commit 身份（`AGENTS.md` §7.1 规则 2）。
 *
 * @param {object} input
 * @param {string} input.tag - 上游 tag（`dsh-v…`）。
 * @param {(cmd: string, args: string[]) => object} [input.runner] - 子进程调用器。
 * @param {string} [input.repo] - `owner/name`。
 * @returns {{status:'ok', sha: string} | {status:'failed', detail: string}}
 */
export function resolveTagCommit({ tag, repo = UPSTREAM_REPO, runner = spawnRunner }) {
  const run = runner ?? spawnRunner;
  const result = run('gh', ['api', `repos/${repo}/commits/${tag}`]);
  if (result.status !== 0) {
    const detail = (String(result.stderr ?? '') + String(result.stdout ?? '')).trim().split(/\r?\n/)[0] || 'gh api 无输出';
    return { status: 'failed', detail: `无法把上游 tag ${tag} 解析成 commit：${detail}` };
  }
  try {
    const sha = JSON.parse(String(result.stdout ?? '')).sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      return { status: 'failed', detail: `上游 tag ${tag} 的响应里没有 40 位 commit sha（收到 ${JSON.stringify(sha)}）` };
    }
    return { status: 'ok', sha };
  } catch (error) {
    return { status: 'failed', detail: `上游 tag ${tag} 的 commit 响应不可解析：${error.message}` };
  }
}

/** 判据：某个字符串是不是 40 位小写十六进制 commit sha。 */
export function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * 纯逻辑自测（**不联网、不读盘**）。
 *
 * @returns {{ passed: number }} 通过项数（计数器统计，不是手写常量）。
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项。
 */
export function selfTest() {
  const failures = [];
  let passed = 0;
  const eq = (label, got, want) => {
    passed += 1;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
    }
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

  // ---- tag ↔ 版本：前缀是 `dsh-v`，不是 `v`（文件头事实 1 的可执行形态）----
  eq('tag：alpha 上游 → dsh-v 前缀', tagForVersion('0.2.1-alpha.1'), 'dsh-v0.2.1-alpha.1');
  eq('tag：rc 上游', tagForVersion('0.2.0-rc.2'), 'dsh-v0.2.0-rc.2');
  eq('tag：连续小版本', tagForVersion('0.1.2-alpha.5'), 'dsh-v0.1.2-alpha.5');
  throws('tag：空串必须抛（不许凭空造 tag）', () => tagForVersion(''));
  throws('tag：dist-tag 名必须抛', () => tagForVersion('next'));
  throws('tag：带 v 前缀必须抛（写错会让前缀变成 vv）', () => tagForVersion('v0.2.1-alpha.1'));
  eq('反解：dsh-v 前缀可解', versionFromTag('dsh-v0.2.1-alpha.1'), '0.2.1-alpha.1');
  // 🔴 这一条就是实测到的那处缺陷：旧实现拼的是 `v<x>`，对上游恒 404。
  eq('反解：**`v<x>` 形态必须返回 null**（旧实现的错误形态）', versionFromTag('v0.2.1-alpha.1'), null);
  eq('反解：别的产品线 tag 返回 null', versionFromTag('cli-v0.2.1-alpha.1'), null);
  eq('反解：tag 与版本互为逆运算', versionFromTag(tagForVersion('0.1.7-rc.2')), '0.1.7-rc.2');

  // ---- API 路径 ----
  eq('路径：默认 slug 与分页', releasesApiPath(), 'repos/deepseek-ai/deepseek-harness/releases?per_page=100');
  throws('路径：slug 必须是 owner/name', () => releasesApiPath('deepseek-harness'));
  throws('路径：slug 不许带空格', () => releasesApiPath('deepseek-ai/ deepseek-harness'));

  // ---- 规范化：draft / 形态不符必须**被报告**，不能静默丢 ----
  const raw = [
    { tag_name: 'dsh-v0.2.1-alpha.1', prerelease: true, published_at: '2026-10-03T06:42:19Z', target_commitish: 'master' },
    { tag_name: 'dsh-v0.2.0-rc.2', prerelease: true, published_at: '2026-09-29T09:42:36Z', target_commitish: 'master' },
    { tag_name: 'dsh-v0.9.9-rc.1', prerelease: true, draft: true, target_commitish: 'master' },
    { tag_name: 'v0.0.1', prerelease: true, target_commitish: 'master' },
    { tag_name: '', prerelease: true },
  ];
  const normalized = normalizeReleases(raw);
  eq('规范化：只保留可用项', normalized.releases.map((r) => r.version), ['0.2.1-alpha.1', '0.2.0-rc.2']);
  eq('规范化：被排除项逐条给出原因', normalized.ignored.length, 3);
  eq('规范化：draft 被点名', normalized.ignored[0].tag, 'dsh-v0.9.9-rc.1');
  eq('规范化：形态不符被点名', normalized.ignored[1].tag, 'v0.0.1');
  eq('规范化：target_commitish 原样带出（**不是** commit）', normalized.releases[0].commitish, 'master');
  eq('规范化：非数组输入不炸', normalizeReleases(null).releases, []);

  // ---- 取最新：比较器必须显式（不许用默认值猜口径）----
  const cmp = (a, b) => {
    const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const x = pa[i] ?? '';
      const y = pb[i] ?? '';
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  };
  eq('取最新：按 semver 取最大（**不是**按数组序）', pickNewestRelease(normalized.releases, cmp).version, '0.2.1-alpha.1');
  eq('取最新：顺序颠倒也一样', pickNewestRelease([...normalized.releases].reverse(), cmp).version, '0.2.1-alpha.1');
  eq('取最新：空清单 → null', pickNewestRelease([], cmp), null);
  throws('取最新：不给比较器必须抛', () => pickNewestRelease(normalized.releases));

  // ---- 四态：ok / empty / skip / error，**error 与 skip 必须分开** ----
  const okRunner = () => ({ status: 0, stdout: JSON.stringify(raw), stderr: '', error: null });
  eq('取数：正常 → ok', fetchUpstreamReleases({ runner: okRunner }).status, 'ok');
  eq('取数：正常 → 条数', fetchUpstreamReleases({ runner: okRunner }).releases.length, 2);

  const allFiltered = () => ({ status: 0, stdout: JSON.stringify([{ tag_name: 'v1.0.0' }]), stderr: '', error: null });
  const emptyResult = fetchUpstreamReleases({ runner: allFiltered });
  eq('取数：全部被排除 → empty（**不是 ok**）', emptyResult.status, 'empty');
  eq('取数：empty 的理由必须点名原因（否则与「没有漂移」同形）', emptyResult.reason.includes('v1.0.0'), true);
  eq(
    '取数：仓库真的没有 Release → 也报 empty 且说清是「一条都没有」',
    fetchUpstreamReleases({ runner: () => ({ status: 0, stdout: '[]', stderr: '', error: null }) }).reason.includes('一条 Release 都没有'),
    true,
  );

  const notFound = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', error: null });
  eq('取数：404 → error（配置缺陷判红，**不是** skip）', fetchUpstreamReleases({ runner: notFound }).status, 'error');
  const noGh = () => ({ status: 1, stdout: '', stderr: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) });
  eq('取数：gh 未安装 → skip（外部状态）', fetchUpstreamReleases({ runner: noGh }).status, 'skip');
  const offline = () => ({ status: 1, stdout: '', stderr: 'dial tcp: connect: network is unreachable', error: null });
  eq('取数：网络不可达 → skip', fetchUpstreamReleases({ runner: offline }).status, 'skip');
  eq('取数：skip 必须带理由（§7.1 规则 3）', fetchUpstreamReleases({ runner: offline }).reason.length > 0, true);
  eq(
    '取数：响应不可解析 → error',
    fetchUpstreamReleases({ runner: () => ({ status: 0, stdout: '<html>', stderr: '', error: null }) }).status,
    'error',
  );
  eq(
    '取数：响应不是数组 → error（端点路径写错时就是这个形态）',
    fetchUpstreamReleases({ runner: () => ({ status: 0, stdout: '{"message":"x"}', stderr: '', error: null }) }).status,
    'error',
  );

  // ---- 按 tag 取单条 Release（前门步骤①的准入判据）----
  const byTagRunner = (payload) => () => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', error: null });
  const byTag = fetchUpstreamReleaseByTag({
    tag: 'dsh-v0.2.1-alpha.1',
    runner: byTagRunner({
      tag_name: 'dsh-v0.2.1-alpha.1',
      draft: false,
      prerelease: true,
      published_at: '2026-10-03T06:42:19Z',
      target_commitish: 'master',
    }),
  });
  eq('按 tag：命中 → ok', byTag.status, 'ok');
  eq('按 tag：带出精确上游版本', byTag.release.version, '0.2.1-alpha.1');
  eq('按 tag：draft 如实带出（由调用方决定是否判红）', byTag.release.draft, false);
  eq('按 tag：404 → failed', fetchUpstreamReleaseByTag({ tag: 'dsh-v9.9.9', runner: notFound }).status, 'failed');
  eq('按 tag：空 tag → failed（不猜）', fetchUpstreamReleaseByTag({ tag: '', runner: okRunner }).status, 'failed');
  // 🔴 端点异常：按 tag 查却回了别的 tag —— 当成功会让下游拿到错版本的元数据。
  eq(
    '按 tag：响应 tag_name 与请求不符 → failed',
    fetchUpstreamReleaseByTag({ tag: 'dsh-v0.2.1-alpha.1', runner: byTagRunner({ tag_name: 'dsh-v0.1.0-rc.8' }) }).status,
    'failed',
  );
  eq(
    '按 tag：响应 tag 形态不符 → failed',
    fetchUpstreamReleaseByTag({ tag: 'v0.2.1-alpha.1', runner: byTagRunner({ tag_name: 'v0.2.1-alpha.1' }) }).status,
    'failed',
  );
  eq(
    '按 tag：响应不可解析 → failed',
    fetchUpstreamReleaseByTag({ tag: 'x', runner: () => ({ status: 0, stdout: 'oops', stderr: '', error: null }) }).status,
    'failed',
  );
  eq(
    '按 tag：响应是数组 → failed',
    fetchUpstreamReleaseByTag({ tag: 'x', runner: () => ({ status: 0, stdout: '[]', stderr: '', error: null }) }).status,
    'failed',
  );

  // ---- commit 解析：`master` 不是 commit ----
  eq('sha 判据：40 位十六进制', isCommitSha('5badb15009ae1756c3afe0ae0cef1faafc290ccc'), true);
  eq('sha 判据：分支名不是 sha', isCommitSha('master'), false);
  eq(
    'commit 解析：走 commits 端点取真 SHA',
    resolveTagCommit({
      tag: 'dsh-v0.2.1-alpha.1',
      runner: () => ({ status: 0, stdout: JSON.stringify({ sha: '5badb15009ae1756c3afe0ae0cef1faafc290ccc' }), stderr: '', error: null }),
    }).sha,
    '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
  );
  eq(
    'commit 解析：拿不到时判失败（不回落成分支名）',
    resolveTagCommit({ tag: 'dsh-v0.2.1-alpha.1', runner: notFound }).status,
    'failed',
  );
  eq(
    'commit 解析：响应里不是 40 位 sha 也判失败',
    resolveTagCommit({ tag: 'x', runner: () => ({ status: 0, stdout: '{"sha":"master"}', stderr: '', error: null }) }).status,
    'failed',
  );

  if (failures.length > 0) {
    throw new Error(`upstream-release 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `upstream-release.mjs — 上游 DSH 发布面（GitHub Release）唯一产地

  （无参数）   真查一次并打印（排障用：需要 gh 与网络）
  --self-test  纯逻辑自测（不联网）
  --help       显示本帮助`;

/**
 * CLI 主入口。
 *
 * @param {string[]} args - `process.argv.slice(2)`。
 * @returns {number} 退出码（0 成功或 SKIP / 1 error / 2 用法错误）。
 */
function main(args) {
  if (args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ upstream-release 自测通过（${passed} 项）`);
    return 0;
  }
  const repo = args.find((arg) => arg.includes('/') && !arg.startsWith('--')) ?? UPSTREAM_REPO;
  const result = fetchUpstreamReleases({ repo });
  if (result.status !== 'ok') {
    const head = result.status === 'error' ? '❌' : '⚠️ ';
    console.log(`${head} ${result.status.toUpperCase()} —— ${result.reason}`);
    if (result.status === 'error') return 1;
    console.log('   ⚠️ 这不是「已核对」：只是这次没拿到上游 Release，漂移未知。');
    return 0;
  }
  console.log(`上游 ${repo} 的 Release（${result.releases.length} 条可用，排除 ${result.ignored.length} 条）：`);
  for (const release of result.releases) {
    console.log(`  ${release.tag.padEnd(22)} ${release.prerelease ? 'prerelease' : 'release   '}  ${release.publishedAt ?? '未知'}`);
  }
  for (const entry of result.ignored) console.log(`  （排除）${entry.tag} —— ${entry.why}`);
  return 0;
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  exit(main(argv.slice(2)));
}
