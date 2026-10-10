#!/usr/bin/env node
/**
 * sync-upstream-release.mjs — 合成号发布的前门（计划 §4.6 **2c**）。
 *
 * ## 它负责哪九步（§4.6 2c 原文）
 *
 * | # | 步骤 | 本脚本的实现 |
 * |---|---|---|
 * | ① | 查上游 Release 存在 | `fetchUpstreamReleaseByTag(tagForVersion(v))`——**默认就是真检查**（slug 见 `upstream-release.mjs` 的 `UPSTREAM_REPO`）；`--upstream-repo ''` 可显式关掉并记 `SKIPPED`（§7.1 规则 3：禁止**无声**降级） |
 * | ② | 取上游 commit | 同 ①（同一 Release 查询）+ **另走 `commits/<tag>` 解析 SHA**；写进台账的 `upstreamCommit` |
 * | ③ | 校验 npm 上该精确版本**可安装** | `npm view @deepseek-ai/dsh@<精确版本> version`——判据是**精确版本可解析**，不是 dist-tag 可解析 |
 * | ④ | 锁 exact | {@link validateExactSpec}：拒绝 `^` / `~` / `>=` / `*` / dist-tag / 空格 |
 * | ⑤ | 更新 lock | **委托** `prepare-harness.mjs --update-lockfile`（家族钉死 + `npm install --package-lock-only` 已在那里实现，不重造） |
 * | ⑥ | 递增/新建本仓计数 | `planNextDesktopVersion()`（台账推 `n`；上游前进 ⇒ 归 1） |
 * | ⑦ | 同步 `package.json`/`Cargo.toml`/`Cargo.lock` 写**合成号** | 复用 `version.mjs` 的 `writeVersion()` + `refreshLock()`（唯一真源机制不变，**填充者**换成合成函数） |
 * | ⑧ | 跑补丁适用性 | 子进程调 `check-patch-applicability.mjs` |
 * | ⑨ | 产出 MANIFEST 元数据基线 | 回填台账的 `upstreamTag` / `upstreamCommit`（MANIFEST v3 形状是 **2g**，不在这里做） |
 * | **前置** | **第 3 步（出 Release Plan）必须先完成** | `readReleasePlan()` + `checkPlanLineFor()`：`release-manifest.json` 必须批准本次这条线（见下节） |
 *
 * **任一步失败 ⇒ 不写版本、不打 tag、不发布**（§4.6 原文）。
 *
 * ## 🔴 第 3→4 步的强制点（2026-10-10 接入）
 *
 * `docs/version-policy.md` §3.1 的权威链路是 `Feature Log → Release Plan → Version`，
 * 即「第 3 步出计划、第 4 步派生」。本条链路上唯一能**强制**它的地方就是这里：
 * 派生版本号之前先读 `release-manifest.json`，用 `checkPlanLineFor()` 断言
 * 「这一次要发的这条线**被批准过**、计划里的 `n` 等于台账现算的下一个、`w` 与本次一致」。
 * 不通过 ⇒ 判红、不派生。
 *
 * ⚠️ 时点判据**只作用于本次目标行**（`checkPlanLineFor` 内部传 `sequenceTarget`）：
 * 先后发两条线时（如先 alpha 后 next），发 next 时计划里 alpha 行的 `n` 必然已是历史值——
 * 若全计划跑时点判据，就等于逼人乱改非目标行的 `n`（ADR-061「n 不由人填」被绕开）。
 * 2026-10-10 next 线 `--apply` 首跑实锤：alpha 历史行判红，阻断 next 派生。
 *
 * ⚠️ 缺计划文件同样判红（**不**当成「没有计划，直接派生」）：那样派生出的 `n` 是无人决策过的，
 * 而它长得和有人决策过的一模一样。
 *
 * ## 🔴 自动化边界（2026-10-08 维护者裁决：`--plan` 默认 + `--apply` 显式）
 *
 * - **默认（`--plan`）只读**：打印将要发生的每一件事，**不落盘**。
 * - `--apply` 才执行写路径，且带「**快照 → 改 → 跑守卫 → 失败即回滚**」。
 * - `--apply --upstream <新版本>`（**锚点前进**）会被**显式拒绝**：它牵连 `inputs.json`、
 *   **补丁目录改名**（补丁文件名锚的是上游精确版本段）与三个文档 pin 表 + 散文
 *   （`verify-plan-facts` C1 要求同批）。补丁的重铸是人与工具（`recount-patches`）的活，
 *   在这里自动改名只会产出「看起来配好了、实际一推就碎」的仓库。
 *   ⇒ **同锚点、只递增本仓计数**（首个合成号 `0.2.1-alpha.1.1` 就是这种）是常规路径，
 *   它**不触碰**上述任何高危文件，`--apply` 对它完全可用。
 *
 * ## `--no-counter`（纯查询）
 *
 * 只跑 ①②③④（上游可信性），**不推导 n、不写任何东西**——供 `version:show` 与 CI 只读调用。
 *
 * ## CLI
 *
 * ```
 * node scripts/sync-upstream-release.mjs                       # --plan（默认，只读）
 *   --target <next|alpha>      目标（默认 DEFAULT_TARGET）
 *   --upstream <版本>          上游精确版本；缺省 = 当前锚点 dshVersion（同锚点、只递增计数）
 *   --w <标签>                 可选人读标签（[0-9A-Za-z-]，禁 _）
 *   --upstream-repo <slug>     可选：上游 GitHub 仓库（启用步骤①②的硬检查）
 *   --no-counter               纯查询：只核上游，不推 n
 *   --apply                    真写（快照 → 改 → 跑守卫 → 失败回滚）
 *   --self-test                纯逻辑自测（不读盘、不联网）
 * ```
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TARGET, DSH_TARGETS, parseVersionShape, resolveTarget } from './dsh-targets.mjs';
import {
  LEDGER_RELATIVE,
  PLAN_RELATIVE,
  allBuilds,
  checkLedger,
  checkLedgerAgainstVersion,
  checkPlanLineFor,
  composeDesktopVersion,
  deriveReleaseChannel,
  ledgerPath,
  planNextDesktopVersion,
  readLedger,
  readReleasePlan,
} from './release-ledger.mjs';
import {
  UPSTREAM_REPO,
  fetchUpstreamReleaseByTag,
  isCommitSha,
  resolveTagCommit,
  tagForVersion,
} from './upstream-release.mjs';
import { refreshLock, writeVersion } from './version.mjs';

/** 上游 npm 包名（唯一产地：`prepare-harness.mjs` 的家族钉死也用它）。 */
export const NPM_PACKAGE = '@deepseek-ai/dsh';

/** 补丁适用性脚本（步骤⑧委托给它）。 */
export const PATCH_APPLICABILITY_SCRIPT = 'scripts/check-patch-applicability.mjs';

/**
 * 步骤④：**锁 exact** 的判据。上游身份必须是**精确版本**。
 *
 * `^` / `~` / `>=` 这类范围会让「这一版到底装的是哪个上游」变成解析期才决定的偶然；
 * dist-tag（`next` / `alpha` / `latest`）是**活的**（实测一天内前进过一版）⇒ 两次组装
 * 可能装进两个不同的上游。两者都让「合成号与上游的对应关系」失效。
 *
 * @param {string} spec - `inputs.json` / 命令行给出的上游标识。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function validateExactSpec(spec) {
  const problems = [];
  const raw = String(spec ?? '').trim();
  if (raw === '') return [`上游标识为空——必须是 ${NPM_PACKAGE}@<精确版本>`];
  if (!/^\d/.test(raw)) {
    return [`上游标识 ${JSON.stringify(raw)} 不是以数字开头的精确版本（dist-tag / 范围都不允许，步骤④）`];
  }
  const shape = parseVersionShape(raw);
  if (!shape.ok) {
    problems.push(`上游标识 ${JSON.stringify(raw)} 不是合法 semver（步骤③④要求精确版本，禁止范围或 dist-tag）`);
  }
  if (shape.ok && shape.build !== null) {
    problems.push(`上游标识 ${JSON.stringify(raw)} 带 build 段——build 是上游元数据，不是可安装的版本标识`);
  }
  return problems;
}

/**
 * 步骤③（及①②）：向上游核验「这个精确版本真实存在且可安装」。
 *
 * 判据是 **`npm view <pkg>@<精确版本> version` 能解析回同一个版本**——这同时证明
 * 「版本存在」与「可安装」（registry 返回的是 metadata，`npm ci` 装的就是它）。
 *
 * ⚠️ Windows 上 `npm` 是 `npm.cmd`，`spawnSync` 不带 `shell` 会直接 `ENOENT`
 * （与 `gates.mjs` 跑 `cargo` 用 `shell: platform === 'win32'` 是同一条纪律）。
 *
 * @param {string} upstreamDsh - 上游精确版本。
 * @returns {{ ok: boolean, detail: string }} 核验结果（不抛错；失败由调用方判红）。
 */
export function verifyNpmInstallable(upstreamDsh) {
  const result = spawnSync('npm', ['view', `${NPM_PACKAGE}@${upstreamDsh}`, 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    const detail = ((result.stderr ?? '') + (result.stdout ?? '')).trim().split(/\r?\n/)[0] || 'npm view 无输出';
    return { ok: false, detail: `npm 上查不到 ${NPM_PACKAGE}@${upstreamDsh}：${detail}` };
  }
  const got = (result.stdout ?? '').trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (got !== upstreamDsh) {
    return { ok: false, detail: `npm 返回 ${JSON.stringify(got)}，与请求的 ${JSON.stringify(upstreamDsh)} 不一致` };
  }
  return { ok: true, detail: `${NPM_PACKAGE}@${upstreamDsh} 在 npm 上精确可解析（步骤③④通过）` };
}

/**
 * 步骤①②：查上游 GitHub Release 并解析**真实 commit**。
 *
 * ## 为什么默认就是真检查（2026-10-09 起）
 *
 * 这两个步骤此前**只在显式给了 `--upstream-repo` 时才跑**，而全仓没有任何地方传过它
 * ⇒ 它们**从未被执行过**（本仓缺陷族「新增的步骤从未执行过」）。从未执行过的东西里
 * 藏着两处实打实的缺陷（2026-10-09 实测发现）：
 *
 * 1. **tag 形态写成了 `v<x>`**，而上游是 **`dsh-v<x>`** ⇒ 一旦配上 slug 就恒报
 *    「上游 Release 不存在」。现在 tag 由 {@link tagForVersion} 拼，调用方再没有
 *    「自己拼 tag」的机会（前缀的唯一产地在 `upstream-release.mjs`）。
 * 2. **`target_commitish` 不是 commit**：实测 25 条 Release 里绝大多数该字段是分支名
 *    `master`。照抄它会往台账写一个不存在的 commit 身份（§7.1 规则 2 的伪造成功）。
 *    ⇒ 只有它**本身就是 40 位 SHA** 时才采用，否则另走 `commits/<tag>` 解析。
 *
 * ## 参数
 *
 * @param {string} upstreamTag - 上游 Release tag（由 `tagForVersion()` 拼）。
 * @param {string} upstreamRepo - `owner/name`；缺省由调用方传 {@link UPSTREAM_REPO}。
 *   传空串 = **显式**关闭步骤①②（会记 `skipped` 并说明，不静默）。
 * @param {(cmd: string, args: string[]) => object} [runner] - 子进程调用器（自测注入）。
 * @returns {{ status: 'verified'|'skipped'|'failed', problems: string[], notices: string[],
 *   commit: string|null, tag: string|null, commitSource: 'target_commitish'|'commits-api'|null,
 *   publishedAt: string|null }}
 */
export function verifyUpstreamRelease(upstreamTag, upstreamRepo = UPSTREAM_REPO, runner) {
  if (upstreamRepo === null || upstreamRepo === undefined || upstreamRepo === '') {
    return {
      status: 'skipped',
      problems: [],
      notices: [
        `步骤①②（上游 GitHub Release / commit）**未执行**：显式关闭了上游仓库 slug。` +
          `npm 精确可安装（步骤③）仍被强制核验。此降级已按 §7.1 规则 3 显式记录。`,
      ],
      commit: null,
      tag: null,
      commitSource: null,
      publishedAt: null,
    };
  }

  const found = fetchUpstreamReleaseByTag({ tag: upstreamTag, repo: upstreamRepo, runner });
  if (found.status !== 'ok') {
    return {
      status: 'failed',
      problems: [`步骤①：${found.detail}`],
      notices: [],
      commit: null,
      tag: null,
      commitSource: null,
      publishedAt: null,
    };
  }
  const release = found.release;
  // draft 未发布 ⇒ 用户拿不到它，不能作为「上游已交付这一版」的依据。
  if (release.draft === true) {
    return {
      status: 'failed',
      problems: [`步骤①：上游 Release ${release.tag} 仍是 draft（未发布）——draft 不构成交付，不能据此发版。`],
      notices: [],
      commit: null,
      tag: null,
      commitSource: null,
      publishedAt: null,
    };
  }

  // 步骤②：先看 `target_commitish` 是不是本身就是 SHA（少数条目如此，省一次 API 调用）；
  // 否则另走 commits 端点。**不回落成分支名**——那会伪造 commit 身份。
  let sha;
  let source;
  if (isCommitSha(release.commitish)) {
    sha = { status: 'ok', sha: release.commitish };
    source = 'target_commitish';
  } else {
    sha = resolveTagCommit({ tag: release.tag, repo: upstreamRepo, runner });
    source = 'commits-api';
  }
  if (sha.status !== 'ok') {
    return {
      status: 'failed',
      problems: [`步骤②：${sha.detail}`],
      notices: [],
      commit: null,
      tag: release.tag,
      commitSource: null,
      publishedAt: release.publishedAt,
    };
  }

  const commitishNote = isCommitSha(release.commitish)
    ? ''
    : `（Release 的 target_commitish 是 ${JSON.stringify(release.commitish)}——那是分支名不是 commit，故经 commits 端点解析）`;
  return {
    status: 'verified',
    problems: [],
    notices: [
      `步骤①②：上游 Release ${release.tag} 存在（${release.prerelease ? 'prerelease' : 'release'}${
        release.publishedAt ? `，${release.publishedAt}` : ''
      }），commit ${sha.sha.slice(0, 7)}…${commitishNote}`,
    ],
    commit: sha.sha,
    tag: release.tag,
    commitSource: source,
    publishedAt: release.publishedAt,
  };
}

/**
 * 台账里**一条新构建记录**的构造（步骤⑥⑨）。
 *
 * `channel` 取 **`deriveReleaseChannel(patchTarget)`**——台账刻意不存 `releaseChannel`，
 * 它是 `DSH_TARGETS[patchTarget].publishChannel` 的纯函数（见 release-ledger.mjs 的偏离说明）。
 *
 * 🔑 **命名规则（2e，2026-10-09）**：本仓「`channel`」**只**指**桌面通道**
 * （`rc` / `alpha`，由版本后缀推导，见 `desktopChannelForVersion()`）；上游那条 npm
 * dist-tag 一律叫 **`upstreamDistTag`**，且只用于发现。目标表里那个旧名 `channel` 的
 * 字段已改名——它当年之所以叫 `channel`，正是因为把这两个概念混成了一个词。
 * 所以：`entry.channel`（本字段）是**桌面通道**，`entry.upstreamDistTag` 是**上游事实**。
 *
 * @param {object} input
 * @param {string} input.target - 目标名（也是 patchTarget）。
 * @param {string} input.upstreamDsh - 上游精确版本（= 台账索引键）。
 * @param {number} input.n - 本仓序号（由台账推出，**不由人填**）。
 * @param {string|null} [input.w] - 可选人读标签。
 * @param {string} [input.date] - ISO 日期（YYYY-MM-DD）；缺省今天。
 * @param {string|null} [input.upstreamCommit] - 步骤②核验到的上游 commit（未核验为 `null`）。
 * @param {string|null} [input.upstreamTag] - 步骤①核验到的上游 Release tag（未核验为 `null`）。
 *   ⚠️ 它**只在核验通过后**才写：按计划 2c，`upstreamTag` / `upstreamCommit` 都不许填猜测值
 *   （台账 `$comment` 明写），填猜测值 = 伪造成功（§7.1 规则 2）。
 * @returns {{ entry: object, problems: string[] }} 记录与构造期判出的问题。
 */
export function buildLedgerEntry({
  target,
  upstreamDsh,
  n,
  w = null,
  date = new Date().toISOString().slice(0, 10),
  upstreamCommit = null,
  upstreamTag = null,
}) {
  const problems = [];
  const channel = deriveReleaseChannel(target);
  if (channel === null) {
    problems.push(`目标 ${target} 无法派生 publishChannel（releaseChannel 的唯一来源）——先修 DSH_TARGETS 再来`);
  }
  let desktopVersion;
  try {
    desktopVersion = composeDesktopVersion(upstreamDsh, n, w);
  } catch (error) {
    return { entry: null, problems: [...problems, error.message] };
  }
  const entry = {
    channel: channel ?? 'unknown',
    n,
    ...(w ? { w } : {}),
    desktopVersion,
    tag: `v${desktopVersion}`,
    date,
    ...(upstreamTag ? { upstreamTag } : {}),
    ...(upstreamCommit ? { upstreamCommit } : {}),
  };
  return { entry, problems };
}

/**
 * **把一条新记录合入台账**（纯函数）。同键已存在就追加进它的 `builds[]`，
 * 否则新建索引条目（`upstreamDistTag` 取自**目标表的同名字段**——它仅用于发现）。
 *
 * @param {object} ledger - 台账内容。
 * @param {string} upstreamDsh - 上游精确版本（索引键）。
 * @param {object} entry - {@link buildLedgerEntry} 产出的记录。
 * @param {string} target - 目标名（新建索引条目时的 `patchTarget`）。
 * @param {string} upstreamDistTag - 上游 dist-tag（新建索引条目时记录，仅用于发现）。
 * @returns {object} 新台账（不改入参）。
 */
export function withLedgerEntry(ledger, upstreamDsh, entry, target, upstreamDistTag) {
  const releases = { ...ledger.releases };
  const existing = releases[upstreamDsh];
  releases[upstreamDsh] = existing
    ? { ...existing, builds: [...(existing.builds ?? []), entry] }
    : { patchTarget: target, upstreamDistTag, status: 'active', builds: [entry] };
  return { ...ledger, releases };
}

/**
 * **发布前核算**（步骤③④⑥的纯逻辑部分）。联网核验由 {@link verifyNpmInstallable} 单独做，
 * 这里只做「给定核验结果，能不能发」的判定——因此可被自测**纯逻辑**地证伪。
 *
 * @param {object} input
 * @param {string} input.target - 目标名。
 * @param {string} input.upstreamDsh - 上游精确版本。
 * @param {object} input.ledger - 台账内容。
 * @param {string|null} [input.w] - 可选人读标签。
 * @param {boolean} [input.noCounter] - 纯查询模式（不推导 n）。
 * @returns {{ problems: string[], notices: string[], plan: object|null }}
 */
export function planSync({ target, upstreamDsh, ledger, w = null, noCounter = false }) {
  const problems = [];
  const notices = [];
  const shape = parseVersionShape(upstreamDsh);
  if (!shape.ok) {
    return { problems: [...validateExactSpec(upstreamDsh)], notices, plan: null };
  }
  problems.push(...validateExactSpec(upstreamDsh));

  const t = DSH_TARGETS[target];
  if (t === undefined) {
    problems.push(`未知目标 ${JSON.stringify(target)}（可用：${Object.keys(DSH_TARGETS).join(' / ')}）`);
    return { problems, notices, plan: null };
  }

  // 步骤⑥：n 由台账推出。上游**前进**时锚点还停在旧版本 ⇒ 先把「台账没有这个键」如实报出来，
  // 而不是静默当成首个交付（那种情况下锚点本身就要先动，属于 --apply 拒绝的锚点前进路径）。
  const indexed = ledger.releases[upstreamDsh] !== undefined;
  if (!indexed) {
    problems.push(
      `台账里没有 ${upstreamDsh} 这个键（当前锚点是 ${t.dshVersion}）。` +
        `若这是**上游前进**，锚点必须先经 --plan --upstream 审查；本脚本不会在锚点未动的情况下新建台账键。`,
    );
    return { problems, notices, plan: null };
  }

  if (noCounter) {
    return { problems, notices, plan: { mode: 'no-counter', target, upstreamDsh } };
  }

  let planned;
  try {
    planned = planNextDesktopVersion({ builds: allBuilds(ledger), upstreamDsh, w });
  } catch (error) {
    problems.push(error.message);
    return { problems, notices, plan: null };
  }
  // 用「假设已合入」的台账跑非空化判据：桌面号必须逐字可从 (上游键, n, w) 复算出来。
  const hypotheticalEntry = buildLedgerEntry({ target, upstreamDsh, n: planned.n, w });
  if (hypotheticalEntry.entry === null) {
    return { problems: [...problems, ...hypotheticalEntry.problems], notices, plan: null };
  }
  const hypothetical = withLedgerEntry(ledger, upstreamDsh, hypotheticalEntry.entry, target, t.upstreamDistTag);
  problems.push(...checkLedgerAgainstVersion({ ledger: hypothetical, version: planned.desktopVersion }));
  return {
    problems,
    notices,
    plan: {
      mode: 'plan',
      target,
      upstreamDsh,
      n: planned.n,
      w,
      desktopVersion: planned.desktopVersion,
      tag: `v${planned.desktopVersion}`,
      channel: deriveReleaseChannel(target),
      upstreamDistTag: t.upstreamDistTag,
      writes: [
        `${LEDGER_RELATIVE}：releases[${upstreamDsh}].builds 追加 1 条（n=${planned.n}）`,
        'package.json / Cargo.toml：version ← 合成号（复用 version.mjs writeVersion）',
        'Cargo.lock：cargo update --workspace --offline 刷新（生成物，失败为软提示）',
      ],
      delegates: [
        // 🔴 必须是 `--dsh-target=`（**带等号**，且是 `resolveDshTargetArg` 认的那个名）：
        //    `prepare-harness.mjs` 的 `--target=` 是**打包平台/架构**守卫（`win32/x64`），
        //    写成 `--target <名字>`（空格形式）两边都匹配不上——守卫不触发、更不会报错，
        //    而目标会**静默回落 `DEFAULT_TARGET`（next）**。照抄这行 = 以为在做 alpha、
        //    实际更新了 next 的 lockfile，且没有任何输出能看出来（2026-10-10 实地撞到）。
        `步骤⑤ 更新 lock：node scripts/prepare-harness.mjs --dsh-target=${target} --update-lockfile`,
        `步骤⑧ 补丁适用性：node ${PATCH_APPLICABILITY_SCRIPT} --target=${upstreamDsh} --dsh-target=${target}`,
      ],
    },
  };
}

/**
 * **快照**要写的文件，供 `--apply` 失败回滚。
 *
 * ⚠️ 快照文件名用**索引**（`snap-0`…）而不是原路径改写：Windows 文件名不允许 `:`，
 * 绝对路径里的盘符会让 `cpSync` 直接失败。
 *
 * @param {string[]} files - 绝对路径列表。
 * @returns {{ dir: string, restore: () => void, cleanup: () => string|null }} 快照目录与恢复/清理函数。
 */
export function snapshotFiles(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-snapshot-'));
  const mapping = files.map((file, index) => ({ file, saved: join(dir, `snap-${index}`) }));
  for (const { file, saved } of mapping) {
    if (existsSync(file)) cpSync(file, saved);
  }
  return {
    dir,
    restore() {
      for (const { file, saved } of mapping) {
        if (existsSync(saved)) cpSync(saved, file);
        else if (existsSync(file)) rmSync(file, { force: true });
      }
    },
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
        return null;
      } catch (error) {
        return `快照目录未清理（safe-delete 守卫可能拦了批量删除）：${dir}（${error.message}）——请手工删除`;
      }
    },
  };
}

/**
 * 步骤⑧的**参数合成**（纯函数，可证伪）。
 *
 * 🔴 为什么单独抽出来：`--apply` 首次端到端运行（2026-10-10）即暴露——此前这里
 *    **不带任何参数**地 spawn 补丁脚本，子进程打印用法后以非零退出，步骤⑧**恒失败**
 *    并触发整趟回滚。它是「写了但从未真正执行过的步骤」的又一例：`--plan` 不跑步骤⑧，
 *    自测也不覆盖 spawn 参数，于是缺陷存活到首次真跑。
 *
 * 语义（子进程 CLI 的约定，`check-patch-applicability.mjs` 头部）：
 *   · `--target=<版本>` 是**待检的上游版本**（升级候选）⇒ 传上游精确版本 `upstreamDsh`；
 *   · `--dsh-target=<name>` 选**哪一套补丁** ⇒ 传目标键 `target`。
 *
 * @param {object} input
 * @param {string} input.target - 目标键（`next` / `alpha`）。
 * @param {string} input.upstreamDsh - 上游精确版本（如 `0.2.1-alpha.1`）。
 * @returns {string[]|null} 子进程参数；缺输入时返回 `null`（调用方据此直接判失败）。
 */
export function patchApplicabilityArgs({ target, upstreamDsh }) {
  if (!target || !upstreamDsh) return null;
  return [`--target=${upstreamDsh}`, `--dsh-target=${target}`];
}

/**
 * 步骤⑧：补丁适用性（子进程，**不** import——它有自己的 CLI 语义与自测）。
 *
 * @param {object} input
 * @param {string} [input.root] - 仓库根。
 * @param {string} input.target - 目标键（选哪套补丁）。
 * @param {string} input.upstreamDsh - 待检的上游精确版本。
 * @returns {{ ok: boolean, detail: string }}
 */
export function runPatchApplicability({ root = process.cwd(), target, upstreamDsh } = {}) {
  const args = patchApplicabilityArgs({ target, upstreamDsh });
  if (args === null) {
    return {
      ok: false,
      detail:
        '缺 target 或 upstreamDsh ⇒ 无法构造补丁适用性检查的参数' +
        '（--dsh-target 选补丁集、--target 是待检上游版本）。这是调用方缺陷，不是补丁问题。',
    };
  }
  const result = spawnSync(process.execPath, [resolve(root, PATCH_APPLICABILITY_SCRIPT), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = ((result.stdout ?? '') + (result.stderr ?? '')).trim().split(/\r?\n/).slice(-3).join(' | ');
  return { ok: result.status === 0, detail: tail || `exit=${result.status}` };
}

/**
 * 把任意抛出物渲染成**可读**的失败说明。
 *
 * ## 为什么必须有它（真实缺陷的止血）
 *
 * 曾经这里写的是 `` `${error?.message ?? error}` ``。当抛出物**不是** `Error`（对象 / 字符串 /
 * `undefined`）时，模板字符串会产出 `[object Object]`——调用方**无法从输出判断到底哪里错了**，
 * 违反 `AGENTS.md` §7.1 规则 2（失败必须可辨识）。同一处的 `if (!wrote.ok)` 更严重：
 * `writeVersion()` **不返回** `{ ok }`（见 {@link attemptVersionWrite}），于是该分支**恒成立**，
 * 把成功也判成失败并回滚 ⇒ `--apply` 主路径**不可能成功**。
 *
 * @param {unknown} error - 捕获到的任意抛出物。
 * @returns {string} 永远非空、且**永远不是** `[object Object]` 的说明。
 */
export function describeError(error) {
  if (error instanceof Error) return error.message || error.name || '(Error 无 message)';
  if (typeof error === 'string') return error === '' ? '(空字符串)' : error;
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  try {
    // 带循环检测的 JSON 渲染：普通对象与自引用对象都得到**可读**结果，不会退化成 `[object Object]`。
    const seen = new WeakSet();
    const rendered = JSON.stringify(error, (_key, value) => {
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[循环引用]';
        seen.add(value);
      }
      return value;
    });
    if (typeof rendered === 'string' && rendered !== '') return rendered;
  } catch {
    /* 落到下一行的可辨识兜底 */
  }
  // 兜底只服务 JSON 渲染不了的输入（函数、Symbol 等）；它至少**点名类型**，不会含糊成 `[object Object]`。
  return Object.prototype.toString.call(error);
}

/**
 * 步骤⑦的**可注入**封装：执行写版本，并把「抛」与「返回值」两种失败形态归一。
 *
 * ## 契约差异是这一层存在的唯一理由
 *
 * `version.mjs` 里三个写函数的形状**不一致**：
 * - `writeVersion()` → 失败**靠抛**，成功返回 `{ changed }`（**没有** `ok` 字段）；
 * - `refreshLock()` / `writeChangelogSection()` → 返回 `{ ok, detail }`。
 *
 * 照后两者的形状去读 `writeVersion()` 会 `!undefined === true` ⇒ **恒判失败**。
 * 因此这里用 `try/catch` 而不是读返回值，把两种形态统一成 `{ ok, changed | detail }`。
 *
 * @param {object} input
 * @param {() => { changed?: string[] }} input.writer - 真正执行写入的函数（便于注入夹具）。
 * @returns {{ ok: true, changed: string[] } | { ok: false, detail: string }}
 */
export function attemptVersionWrite({ writer }) {
  try {
    const result = writer();
    return { ok: true, changed: Array.isArray(result?.changed) ? result.changed : [] };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }
}

/**
 * 纯逻辑自测（**不读盘、不联网**）。含注入式可伪证夹具。
 *
 * @returns {{ passed: number }} 通过项数。
 * @throws {Error} 任一断言失败时抛出。
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

  // 步骤④：锁 exact。范围与 dist-tag 都必须被判红。
  eq('锁 exact：纯精确版本通过', validateExactSpec('0.2.1-alpha.1'), []);
  eq('锁 exact：^ 范围判红', validateExactSpec('^0.2.0').length > 0, true);
  eq('锁 exact：~ 范围判红', validateExactSpec('~0.2.0').length > 0, true);
  eq('锁 exact：dist-tag 判红', validateExactSpec('next').length > 0, true);
  eq('锁 exact：latest 判红', validateExactSpec('latest').length > 0, true);
  eq('锁 exact：空串判红', validateExactSpec('').length > 0, true);
  eq('锁 exact：带 build 段判红', validateExactSpec('0.2.1-alpha.1+x').length > 0, true);

  // 台账记录：channel 由 patchTarget 派生；w 只在给了才写；commit 只在核验到才写。
  const entry = buildLedgerEntry({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', n: 1 });
  eq('记录：channel = alpha 目标的 publishChannel', entry.entry.channel, 'alpha');
  eq('记录：desktopVersion 由 (上游, n) 合成', entry.entry.desktopVersion, '0.2.1-alpha.1.1');
  eq('记录：tag 与 desktopVersion 逐字对应', entry.entry.tag, 'v0.2.1-alpha.1.1');
  eq('记录：未给 w 就不写这个键', 'w' in entry.entry, false);
  eq('记录：未核验 commit 就不写这个键', 'upstreamCommit' in entry.entry, false);
  eq('记录：next 目标的 channel 是 rc', buildLedgerEntry({ target: 'next', upstreamDsh: '0.2.0-rc.2', n: 1 }).entry.channel, 'rc');
  eq('记录：正式线上游必须报错（ADR-061 决策 7）', buildLedgerEntry({ target: 'next', upstreamDsh: '0.2.1', n: 1 }).problems.length > 0, true);

  // 合入台账：同键追加 / 新键新建，且**不改入参**。
  const ledgerOf = (releases) => ({ schemaVersion: 1, releases });
  const base = ledgerOf({
    '0.2.1-alpha.1': { patchTarget: 'alpha', upstreamDistTag: 'alpha', status: 'active', builds: [{ channel: 'alpha', n: 1, desktopVersion: '0.2.1-alpha.1.1', tag: 'v0.2.1-alpha.1.1', date: '2026-10-08' }] },
  });
  const second = buildLedgerEntry({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', n: 2 }).entry;
  const merged = withLedgerEntry(base, '0.2.1-alpha.1', second, 'alpha', 'alpha');
  eq('合入：同键追加到 builds', merged.releases['0.2.1-alpha.1'].builds.length, 2);
  eq('合入：不改入参', base.releases['0.2.1-alpha.1'].builds.length, 1);
  const fresh = withLedgerEntry(ledgerOf({}), '0.2.1-alpha.1', second, 'alpha', 'alpha');
  eq('合入：新键自动建索引条目', [fresh.releases['0.2.1-alpha.1'].patchTarget, fresh.releases['0.2.1-alpha.1'].upstreamDistTag], ['alpha', 'alpha']);

  // 发布前核算：合法路径 / 缺键路径 / 纯查询模式。
  const ok = planSync({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', ledger: base });
  eq('核算：同锚点第二个合成号可发布', [ok.problems.length, ok.plan.desktopVersion], [0, '0.2.1-alpha.1.2']);
  eq('核算：写出台账写入项', ok.plan.writes.some((x) => x.includes(LEDGER_RELATIVE)), true);
  eq('核算：写出手动委托项（⑤⑧）', ok.plan.delegates.some((x) => x.includes('prepare-harness')), true);
  // 🔴 只断言「提到 prepare-harness」是**对称失效**：夹具与被测犯同一个错（都以为参数名随便写）。
  //    委托串是给人**照抄**的可执行命令，因此成对钉住正确形态与错误形态：
  //      · `--dsh-target=<目标>`（`resolveDshTargetArg` 认的名字，缺它 ⇒ 静默回落 next）；
  //      · 不得出现裸 `--target <名字>`（那是打包平台守卫的形式，且**匹配不上任何东西**）。
  const delegated = ok.plan.delegates.find((x) => x.includes('prepare-harness'));
  eq('核算：委托串用 --dsh-target=（目标参数的正确名字）', delegated.includes('--dsh-target=alpha'), true);
  eq('核算：委托串不得用裸 --target <名字>（会静默回落 next）', /--target\s/.test(delegated), false);
  const missing = planSync({ target: 'alpha', upstreamDsh: '0.2.2-alpha.1', ledger: base });
  eq('核算：锚点未动的上游前进必须判红（不静默新建键）', missing.plan, null);
  const noCounter = planSync({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', ledger: base, noCounter: true });
  eq('核算：--no-counter 不推 n', noCounter.plan.mode, 'no-counter');

  // 🔴 步骤①②的降级必须**显式可见**（§7.1 规则 3）——静默跳过 = 伪造成功。
  const skipped = verifyUpstreamRelease('dsh-v0.2.1-alpha.1', null);
  eq('步骤①②：关掉 slug ⇒ skipped 且带显式说明', [skipped.status, skipped.notices.length > 0], ['skipped', true]);
  eq('步骤①②：skipped 不产生 problem（它不是失败，是已声明的降级）', skipped.problems, []);

  // ---------------------------------------------------------------------------
  // 🔴 步骤①② 的两处真实缺陷（2026-10-09 实测；两者都因为「这段代码从未执行过」而存活）
  //
  //   ① tag 形态：旧实现拼 `v<x>`，上游实际是 `dsh-v<x>` ⇒ 配上 slug 后恒报「Release 不存在」。
  //   ② `target_commitish` 实测多数是**分支名** `master`，不是 commit ⇒ 照抄会往台账写一个
  //      不存在的 commit 身份（§7.1 规则 2）。
  // ---------------------------------------------------------------------------
  eq('接线：tag 走 dsh-v 前缀（唯一产地是 upstream-release.mjs）', tagForVersion('0.2.1-alpha.1'), 'dsh-v0.2.1-alpha.1');

  const SHA = '5badb15009ae1756c3afe0ae0cef1faafc290ccc';
  const fixtureRunner = (responses) => (_cmd, args) => {
    const path = String(args[1] ?? '');
    const hit = responses.find((entry) => path.includes(entry.match));
    if (hit === undefined) return { status: 1, stdout: '', stderr: `自测夹具未覆盖 ${path}`, error: null };
    return { status: hit.status ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', error: null };
  };
  const releasePayload = {
    tag_name: 'dsh-v0.2.1-alpha.1',
    draft: false,
    prerelease: true,
    published_at: '2026-10-03T06:42:19Z',
    target_commitish: 'master',
  };
  const branchCommitish = fixtureRunner([
    { match: '/releases/tags/', stdout: JSON.stringify(releasePayload) },
    { match: '/commits/', stdout: JSON.stringify({ sha: SHA }) },
  ]);
  const verified = verifyUpstreamRelease('dsh-v0.2.1-alpha.1', UPSTREAM_REPO, branchCommitish);
  eq('步骤①②：正常路径 → verified', verified.status, 'verified');
  eq('步骤①②：commit 取的是真 SHA', verified.commit, SHA);
  eq('步骤①②：target_commitish=master 时必须再走 commits 端点', verified.commitSource, 'commits-api');
  eq('反证：commit 不得等于分支名', verified.commit === 'master', false);
  eq('步骤①②：verified 带出上游 tag（供台账回填）', verified.tag, 'dsh-v0.2.1-alpha.1');

  const shaCommitish = fixtureRunner([
    { match: '/releases/tags/', stdout: JSON.stringify({ ...releasePayload, target_commitish: SHA }) },
  ]);
  const shaVerified = verifyUpstreamRelease('dsh-v0.2.1-alpha.1', UPSTREAM_REPO, shaCommitish);
  eq('步骤①②：target_commitish 本身就是 SHA 时直接采用', shaVerified.commitSource, 'target_commitish');
  eq('步骤①②：同上，commit 正确', shaVerified.commit, SHA);

  const draftRunner = fixtureRunner([
    { match: '/releases/tags/', stdout: JSON.stringify({ ...releasePayload, draft: true }) },
  ]);
  const draftResult = verifyUpstreamRelease('dsh-v0.2.1-alpha.1', UPSTREAM_REPO, draftRunner);
  eq('步骤①②：draft 不算交付 ⇒ 判红', draftResult.status, 'failed');
  eq('步骤①②：draft 的理由必须点明 draft', draftResult.problems[0].includes('draft'), true);

  const notFoundRunner = fixtureRunner([{ match: '/releases/tags/', status: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
  eq('步骤①②：上游没有该 Release ⇒ 判红', verifyUpstreamRelease('dsh-v9.9.9', UPSTREAM_REPO, notFoundRunner).status, 'failed');
  eq(
    '步骤①②：理由定位到步骤①',
    verifyUpstreamRelease('dsh-v9.9.9', UPSTREAM_REPO, notFoundRunner).problems[0].startsWith('步骤①'),
    true,
  );

  const noCommitRunner = fixtureRunner([
    { match: '/releases/tags/', stdout: JSON.stringify(releasePayload) },
    { match: '/commits/', status: 1, stderr: 'gh: Not Found (HTTP 404)' },
  ]);
  const noCommit = verifyUpstreamRelease('dsh-v0.2.1-alpha.1', UPSTREAM_REPO, noCommitRunner);
  eq('步骤①②：commit 解析不出来 ⇒ 判红（不回落成分支名）', noCommit.status, 'failed');
  eq('步骤①②：理由定位到步骤②', noCommit.problems[0].startsWith('步骤②'), true);
  eq('步骤①②：commit 拿不到时 commit 为 null（不给半个答案）', noCommit.commit, null);

  // 台账回填：**只有核验过才写**上游字段。填猜测值 = 伪造成功（§7.1 规则 2）。
  eq('台账：核验过才写 upstreamTag', 'upstreamTag' in buildLedgerEntry({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', n: 1, upstreamTag: 'dsh-v0.2.1-alpha.1' }).entry, true);
  eq('台账：核验过才写 upstreamCommit', 'upstreamCommit' in buildLedgerEntry({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', n: 1, upstreamCommit: SHA }).entry, true);
  eq('台账：未核验时两个上游字段都不许出现', ['upstreamTag', 'upstreamCommit'].filter((k) => k in buildLedgerEntry({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', n: 1 }).entry), []);

  // 伪证夹具：内部空白 / 非版本串必须判红。（首尾空白被有意 `trim()` 归一——那是宽容，不是漏洞。）
  eq('锁 exact：内部空格判红', validateExactSpec('0.2.1 alpha.1').length > 0, true);
  eq('锁 exact：尾随空白被归一（放行）', validateExactSpec('0.2.1-alpha.1 '), []);

  // ---------------------------------------------------------------------------
  // 🔴 步骤⑦ 的契约不一致（真实缺陷的回归夹具）
  //
  // `writeVersion()` 失败**靠抛**、成功返回 `{ changed }`——**没有** `ok` 字段。
  // 曾经调用方按兄弟函数（`refreshLock` / `writeChangelogSection` 返回 `{ ok, detail }`）
  // 的形状写成 `if (!wrote.ok)` ⇒ 恒成立 ⇒ **成功也被判失败并回滚**，`--apply` 不可能成功。
  // 下面第 ① 条喂的就是**真实生产者**的返回形状，它是这段缺陷的**直接判据**。
  // ---------------------------------------------------------------------------
  const okShape = attemptVersionWrite({ writer: () => ({ changed: ['package.json', 'Cargo.toml'] }) });
  eq('步骤⑦：喂真实返回形状 {changed}（无 ok 字段）必须判**成功**', okShape.ok, true);
  eq('步骤⑦：透传改写清单', okShape.changed.length, 2);
  const emptyShape = attemptVersionWrite({ writer: () => ({ changed: [] }) });
  eq('步骤⑦：changed 为空也算成功（版本号本来就一致）', emptyShape.ok, true);
  const threwError = attemptVersionWrite({ writer: () => { throw new Error('EPERM: 目标文件只读'); } });
  eq('步骤⑦：抛 Error ⇒ 判失败', threwError.ok, false);
  eq('步骤⑦：失败说明是可读的 message', threwError.detail, 'EPERM: 目标文件只读');
  // 抛出物不是 Error 时，模板字符串会产出 [object Object]——调用方因此无法定位问题。
  const threwObject = attemptVersionWrite({ writer: () => { throw { code: 'EPERM', path: 'Cargo.toml' }; } });
  eq('步骤⑦：抛普通对象 ⇒ 仍判失败', threwObject.ok, false);
  eq('步骤⑦：抛普通对象不得渲染成 [object Object]', threwObject.detail.includes('[object Object]'), false);
  eq('步骤⑦：抛普通对象渲染成 JSON', threwObject.detail, '{"code":"EPERM","path":"Cargo.toml"}');
  eq('步骤⑦：抛字符串原样透出', attemptVersionWrite({ writer: () => { throw '被拒绝'; } }).detail, '被拒绝');
  // describeError 的兜底：任何输入都不得产出 [object Object]，也不得为空。
  eq('describeError：undefined', describeError(undefined), 'undefined');
  eq('describeError：null', describeError(null), 'null');
  eq('describeError：空字符串不返回空串（否则日志里是一行空白）', describeError('') === '', false);
  eq('describeError：数组可读', describeError(['a', 'b']), '["a","b"]');
  // 自引用对象：朴素的 JSON.stringify 会抛，朴素兜底会得到 [object Object]——两者都必须被挡住。
  const cyclic = { code: 'EPERM' };
  cyclic.self = cyclic;
  eq('describeError：循环引用对象仍可读（不抛、不退化成 [object Object]）', describeError(cyclic), '{"code":"EPERM","self":"[循环引用]"}');

  // --- 步骤⑧的参数合成（2026-10-10 真实缺陷的回归夹具）-----------------------
  // 真实形态：`--apply` 首次端到端跑即在此失败——spawn 不带参数，子进程打印用法后退出。
  // 期望值**硬编码**（不得由被测函数现算），并把「缺输入必须判失败」钉住：
  // 若有人把判据弱化成「缺了也返回参数」，下面两条会红。
  eq(
    '步骤⑧：参数形状逐字正确（--target=上游精确版本 --dsh-target=目标键）',
    patchApplicabilityArgs({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1' }),
    ['--target=0.2.1-alpha.1', '--dsh-target=alpha'],
  );
  eq(
    '步骤⑧：next 线同样带两个参数',
    patchApplicabilityArgs({ target: 'next', upstreamDsh: '0.2.0-rc.2' }),
    ['--target=0.2.0-rc.2', '--dsh-target=next'],
  );
  eq('步骤⑧：缺 target ⇒ null（调用方判失败，不得空跑）', patchApplicabilityArgs({ upstreamDsh: '0.2.1-alpha.1' }), null);
  eq('步骤⑧：缺 upstreamDsh ⇒ null', patchApplicabilityArgs({ target: 'alpha' }), null);
  eq('步骤⑧：两者皆缺 ⇒ null', patchApplicabilityArgs({}), null);

  if (failures.length > 0) {
    throw new Error(`sync-upstream-release 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `sync-upstream-release.mjs — 合成号发布的前门（计划 2c；--plan 默认只读）

  （无参数）                等价 --plan
  --plan                    只读：打印九步核算结果，不落盘
  --apply                   真写（快照 → 改 → 跑守卫 → 失败回滚）
  --target <next|alpha>     目标（默认 ${DEFAULT_TARGET}）
  --upstream <版本>         上游精确版本；缺省 = 当前锚点 dshVersion
  --w <标签>                可选人读标签
  --upstream-repo <slug>    覆盖上游 GitHub 仓库（默认 ${UPSTREAM_REPO}）
  --no-upstream-release     显式关闭步骤①②（会记 SKIPPED 及理由，不静默）
  --no-counter              纯查询：只核上游，不推 n
  --self-test               纯逻辑自测
  --help                    显示本帮助`;

/**
 * CLI 主入口。
 *
 * @param {string[]} args - `process.argv.slice(2)`。
 * @returns {number} 退出码（0 成功 / 1 核算失败 / 2 用法错误）。
 */
function main(args) {
  if (args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ sync-upstream-release 自测通过（${passed} 项）`);
    return 0;
  }
  const apply = args.includes('--apply');
  const noCounter = args.includes('--no-counter');
  if (apply && noCounter) {
    console.error(`❌ 用法错误：--apply 与 --no-counter 互斥（后者是纯查询，不推导 n，无东西可写）`);
    return 2;
  }
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const target = at('--target') ?? DEFAULT_TARGET;
  const w = at('--w') ?? null;
  // 步骤①②**缺省即真检查**（slug 的唯一产地在 upstream-release.mjs 的 UPSTREAM_REPO）。
  // `--no-upstream-release` 是显式的关闭开关——要关闭就得说出来，不许靠「忘了传 slug」。
  const noUpstreamRelease = args.includes('--no-upstream-release');
  const upstreamRepoArg = at('--upstream-repo');
  if (noUpstreamRelease && upstreamRepoArg !== undefined) {
    console.error(`❌ 用法错误：--no-upstream-release 与 --upstream-repo 互斥（前者关掉步骤①②，后者指定去哪查）`);
    return 2;
  }
  const upstreamRepo = noUpstreamRelease ? '' : (upstreamRepoArg ?? UPSTREAM_REPO);

  const t = DSH_TARGETS[target];
  if (t === undefined) {
    console.error(`❌ 未知目标 ${JSON.stringify(target)}（可用：${Object.keys(DSH_TARGETS).join(' / ')}）`);
    return 2;
  }
  const upstreamDsh = at('--upstream') ?? t.dshVersion;

  // 🔴 锚点前进路径：--apply 显式拒绝（自动化边界裁决）。
  if (apply && upstreamDsh !== t.dshVersion) {
    console.error(
      `❌ --apply 拒绝：给了 --upstream ${upstreamDsh}，但当前锚点是 ${t.dshVersion}（**锚点前进**）。\n` +
        `   它牵连 inputs.json、补丁目录改名（补丁文件名锚上游精确版本段）与三个文档 pin 表 + 散文，\n` +
        `   且补丁需要按新上游重铸（recount-patches / relocate-patch-hunks）。这是人与工具的活，本脚本不自动改。\n` +
        `   先用 --plan --upstream ${upstreamDsh} 看完整清单，人工完成后重跑 --apply（不带 --upstream）。`,
    );
    return 1;
  }

  const problems = [];
  const notices = [];
  const ledger = readLedger();

  // 步骤①②：上游 Release（缺省真检查；`--no-upstream-release` 才降级，且降级写进输出）。
  // ⚠️ tag 由 tagForVersion() 拼（`dsh-v<x.y.z>`）——**不要**在这里手写 `v${...}`：
  //    前缀写错会让 404 看起来像「上游没发这一版」（该缺陷真实发生过，见 verifyUpstreamRelease）。
  const release = verifyUpstreamRelease(tagForVersion(upstreamDsh), upstreamRepo);
  problems.push(...release.problems);
  if (release.status === 'verified') {
    // 成功用 ✅ 而不是 ⚠️：降级与成功**必须一眼可分**（§7.1 规则 3 的另一半——
    // 只说「禁止无声降级」不够，还得让成功看起来像成功，否则人会把两者一并忽略）。
    for (const notice of release.notices) console.log(`✅ ${notice}`);
  } else {
    notices.push(...release.notices);
  }

  // 步骤③④：npm 精确可安装 + 锁 exact（**必做**，是「上游可信」的最强判据）。
  const npm = verifyNpmInstallable(upstreamDsh);
  if (!npm.ok) problems.push(`步骤③：${npm.detail}`);
  else console.log(`✅ ${npm.detail}`);

  // 台账整体自洽（锚点必须在台账里有键——索引层）。
  problems.push(...checkLedger({ ledger, targets: DSH_TARGETS }));

  // 步骤⑥ + 发布前核算。
  const { problems: planProblems, notices: planNotices, plan } = planSync({ target, upstreamDsh, ledger, w, noCounter });
  problems.push(...planProblems);
  notices.push(...planNotices);

  for (const notice of notices) console.warn(`⚠️  ${notice}`);

  // ---- 第 3→4 步的强制点：Release Plan 必须**批准过**这一条线 ------------------
  // 这是 `release-manifest.json` 在链路上唯一的强制消费点（第 3 步出计划 → 第 4 步派生版本号）。
  // 少了它，那份文件就是**没人读**的（而它长得像决策面，`docs/version-policy.md` §3.1 把它
  // 画成唯一权威链路上的一环）——本仓缺陷族「文档承诺了、代码不读」。
  //
  // ⚠️ 判据是**时点**的（`n` 必须等于台账现算的下一个）：它在这里成立，因为这里**就是**决策时刻；
  //    放进每次 PR 都跑的门禁则不成立（发完之后计划里的 n 必然成为历史值，会逼人乱改 n）。
  //    两组判据的分工见 `release-ledger.mjs::diagnoseReleasePlan()` 的 boxed 段。
  // ⚠️ `--no-counter` 是纯上游可信性查询（不推导 n、无东西可写）⇒ 不要求计划。
  if (plan.mode !== 'no-counter') {
    let releasePlan = null;
    try {
      releasePlan = readReleasePlan();
    } catch (error) {
      problems.push(
        `步骤③：${PLAN_RELATIVE} 读不到 —— ${error.message}\n` +
          `   第 4 步派生版本号之前必须先有第 3 步的决定；缺计划时**不得**直接派生` +
          `（那种情况下派生出的 n 是「没人决策过」的）。`,
      );
    }
    if (releasePlan !== null) {
      const planLineProblems = checkPlanLineFor({ plan: releasePlan, ledger, target, w, targets: DSH_TARGETS });
      problems.push(...planLineProblems.map((p) => `步骤③：${p}`));
      if (planLineProblems.length === 0) {
        console.log(
          `✅ 步骤③④：Release Plan 批准了 ${target} 线（n=${plan.n}${w ? `，w=${w}` : ''}）⇒ 与派生值逐字一致`,
        );
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    console.error(`\n核算失败（${problems.length} 项）——不写版本、不打 tag、不发布（§4.6）。`);
    return 1;
  }

  if (!apply) {
    console.log('\n📋 --plan（只读，未落盘）：');
    if (plan.mode === 'no-counter') {
      console.log(`  目标 ${target} / 上游 ${upstreamDsh}：上游可信性核验通过（--no-counter，不推导 n）`);
      return 0;
    }
    console.log(`  目标 ${target} → 合成号 ${plan.desktopVersion}（n=${plan.n}${plan.w ? `，w=${plan.w}` : ''}，channel=${plan.channel}）`);
    for (const item of plan.writes) console.log(`  · 写：${item}`);
    for (const item of plan.delegates) console.log(`  · 委托：${item}`);
    console.log('\n  加 --apply 执行写路径（快照 → 改 → 跑守卫 → 失败回滚）。');
    return 0;
  }

  // ---- --apply：快照 → 改 → 守卫 → 失败回滚 ----
  const { entry, problems: entryProblems } = buildLedgerEntry({
    target,
    upstreamDsh,
    n: plan.n,
    w,
    upstreamCommit: release.commit,
    upstreamTag: release.tag,
  });
  if (entryProblems.length > 0 || entry === null) {
    for (const problem of entryProblems) console.error(`❌ ${problem}`);
    return 1;
  }
  const versionFiles = [join(process.cwd(), 'package.json'), join(process.cwd(), 'Cargo.toml')];
  // ⚠️ Cargo.lock 必须进快照：步骤⑤的 refreshLock 会改写它（含 workspace 成员版本号），
  //    而后续任一步失败回滚时，若它不在快照里，就会残留「版本文件已回滚、lock 里还是
  //    新版本号」的半套状态（2026-10-10 首次 --apply 实测泄漏过一次：步骤⑧失败后
  //    Cargo.lock 里残留 0.2.1-alpha.1.1，而 package.json 已回滚成 0.7.4-alpha.1）。
  const lockFile = join(process.cwd(), 'Cargo.lock');
  const snapshot = snapshotFiles([ledgerPath(), ...versionFiles, lockFile]);
  console.log(`📸 快照：${snapshot.dir}`);

  const newLedger = withLedgerEntry(ledger, upstreamDsh, entry, target, t.upstreamDistTag);
  writeFileSync(ledgerPath(), `${JSON.stringify(newLedger, null, 2)}\n`, 'utf8');
  const backfilled = [release.tag ? `upstreamTag=${release.tag}` : '', release.commit ? `upstreamCommit=${release.commit.slice(0, 7)}…（${release.commitSource}）` : '']
    .filter(Boolean)
    .join('，');
  console.log(
    `✅ 步骤⑥⑨：台账 ${LEDGER_RELATIVE} 追加 n=${plan.n}${backfilled ? `，回填 ${backfilled}` : '（上游未核验 ⇒ 两个上游字段都不写，填猜测值等于伪造）'}`,
  );

  // 🔴 不得写 `if (!writeVersion(...).ok)`：writeVersion 失败靠**抛**、成功返回 `{ changed }`，
  //    没有 `ok` 字段 ⇒ 该判断恒成立，成功也会被当成失败并回滚（真实缺陷，见 attemptVersionWrite）。
  const wrote = attemptVersionWrite({ writer: () => writeVersion(plan.desktopVersion) });
  if (!wrote.ok) {
    snapshot.restore();
    const cleaned = snapshot.cleanup();
    if (cleaned) console.warn(`⚠️  ${cleaned}`);
    console.error(`❌ 步骤⑦：写版本失败（已回滚）：${wrote.detail}`);
    return 1;
  }
  console.log(`✅ 步骤⑦：package.json / Cargo.toml ← ${plan.desktopVersion}（改写 ${wrote.changed.length} 个文件）`);
  const lock = refreshLock();
  console.log(`${lock.ok ? '✅' : '⚠️ '} Cargo.lock：${lock.detail}`);

  const patches = runPatchApplicability({ target, upstreamDsh });
  if (!patches.ok) {
    snapshot.restore();
    const cleaned = snapshot.cleanup();
    if (cleaned) console.warn(`⚠️  ${cleaned}`);
    console.error(`❌ 步骤⑧：补丁适用性失败（已回滚）：${patches.detail}`);
    return 1;
  }
  console.log(`✅ 步骤⑧：补丁适用性通过`);

  const cleaned = snapshot.cleanup();
  if (cleaned) console.warn(`⚠️  ${cleaned}`);
  console.log(`\n✅ 合成号 ${plan.desktopVersion} 已落地（台账 + 版本文件）。下一步：手动跑步骤⑤（更新 lock）→ 提交 → 打 tag。`);
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
