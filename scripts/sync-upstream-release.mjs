#!/usr/bin/env node
/**
 * sync-upstream-release.mjs — 合成号发布的前门（计划 §4.6 **2c**）。
 *
 * ## 它负责哪九步（§4.6 2c 原文）
 *
 * | # | 步骤 | 本脚本的实现 |
 * |---|---|---|
 * | ① | 查上游 Release 存在 | 仅当给了 `--upstream-repo <slug>` 才做**硬**检查；否则**显式**记 `SKIPPED` 及理由（§7.1 规则 3：禁止**无声**降级） |
 * | ② | 取上游 commit | 同 ①（同一 API 调用）；写进台账的 `upstreamCommit` |
 * | ③ | 校验 npm 上该精确版本**可安装** | `npm view @deepseek-ai/dsh@<精确版本> version`——判据是**精确版本可解析**，不是 dist-tag 可解析 |
 * | ④ | 锁 exact | {@link validateExactSpec}：拒绝 `^` / `~` / `>=` / `*` / dist-tag / 空格 |
 * | ⑤ | 更新 lock | **委托** `prepare-harness.mjs --update-lockfile`（家族钉死 + `npm install --package-lock-only` 已在那里实现，不重造） |
 * | ⑥ | 递增/新建本仓计数 | `planNextDesktopVersion()`（台账推 `n`；上游前进 ⇒ 归 1） |
 * | ⑦ | 同步 `package.json`/`Cargo.toml`/`Cargo.lock` 写**合成号** | 复用 `version.mjs` 的 `writeVersion()` + `refreshLock()`（唯一真源机制不变，**填充者**换成合成函数） |
 * | ⑧ | 跑补丁适用性 | 子进程调 `check-patch-applicability.mjs` |
 * | ⑨ | 产出 MANIFEST 元数据基线 | 回填台账的 `upstreamTag` / `upstreamCommit`（MANIFEST v3 形状是 **2g**，不在这里做） |
 *
 * **任一步失败 ⇒ 不写版本、不打 tag、不发布**（§4.6 原文）。
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
  allBuilds,
  checkLedger,
  checkLedgerAgainstVersion,
  composeDesktopVersion,
  deriveReleaseChannel,
  ledgerPath,
  planNextDesktopVersion,
  readLedger,
} from './release-ledger.mjs';
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
 * 步骤①②：查上游 GitHub Release（**仅当**给了 slug 才执行）。
 *
 * 为什么是「可选的硬检查」而不是「必做」：本仓**没有任何**配置指向上游 GitHub 仓库
 * （grep 全 `scripts/` 零命中），凭空编一个 slug 才是伪造。缺省时降级**必须写进输出**
 * （§7.1 规则 3），并留待 2f（漂移哨兵换 GitHub Release 基准）落地时接上真 slug。
 *
 * @param {string} upstreamTag - 上游 tag（本仓约定为 `v<上游版本>`）。
 * @param {string|null} upstreamRepo - `owner/name`；`null` = 未配置。
 * @returns {{ status: 'verified'|'skipped', problems: string[], notices: string[], commit: string|null }}
 */
export function verifyUpstreamRelease(upstreamTag, upstreamRepo) {
  if (upstreamRepo === null || upstreamRepo === undefined || upstreamRepo === '') {
    return {
      status: 'skipped',
      problems: [],
      notices: [
        `步骤①②（上游 GitHub Release / commit）**未执行**：未配置 --upstream-repo。` +
          `npm 精确可安装（步骤③）仍被强制核验。此降级已按 §7.1 规则 3 显式记录。`,
      ],
      commit: null,
    };
  }
  const result = spawnSync(
    'gh',
    ['api', `repos/${upstreamRepo}/releases/tags/${upstreamTag}`, '--jq', '{tag: .tag_name, commit: .target_commitish}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    const detail = ((result.stderr ?? '') + (result.stdout ?? '')).trim().split(/\r?\n/)[0] || 'gh api 无输出';
    return {
      status: 'failed',
      problems: [`步骤①：上游 ${upstreamRepo} 没有 Release ${JSON.stringify(upstreamTag)}：${detail}`],
      notices: [],
      commit: null,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      status: 'verified',
      problems: [],
      notices: [`步骤①②：上游 Release ${upstreamTag} 存在，commit ${JSON.stringify(parsed.commit ?? 'unknown')}`],
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
    };
  } catch {
    return {
      status: 'failed',
      problems: [`步骤①：上游 Release 响应不可解析：${(result.stdout ?? '').slice(0, 120)}`],
      notices: [],
      commit: null,
    };
  }
}

/**
 * 台账里**一条新构建记录**的构造（步骤⑥⑨）。
 *
 * `channel` 取 **`deriveReleaseChannel(patchTarget)`**——台账刻意不存 `releaseChannel`，
 * 它是 `DSH_TARGETS[patchTarget].publishChannel` 的纯函数（见 release-ledger.mjs 的偏离说明）。
 *
 * @param {object} input
 * @param {string} input.target - 目标名（也是 patchTarget）。
 * @param {string} input.upstreamDsh - 上游精确版本（= 台账索引键）。
 * @param {number} input.n - 本仓序号（由台账推出，**不由人填**）。
 * @param {string|null} [input.w] - 可选人读标签。
 * @param {string} [input.date] - ISO 日期（YYYY-MM-DD）；缺省今天。
 * @param {string|null} [input.upstreamCommit] - 步骤②核验到的上游 commit（未核验为 `null`）。
 * @returns {{ entry: object, problems: string[] }} 记录与构造期判出的问题。
 */
export function buildLedgerEntry({ target, upstreamDsh, n, w = null, date = new Date().toISOString().slice(0, 10), upstreamCommit = null }) {
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
    ...(upstreamCommit ? { upstreamCommit } : {}),
  };
  return { entry, problems };
}

/**
 * **把一条新记录合入台账**（纯函数）。同键已存在就追加进它的 `builds[]`，
 * 否则新建索引条目（`upstreamDistTag` 由目标的 `channel` 推出——它只用于发现）。
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
  const hypothetical = withLedgerEntry(ledger, upstreamDsh, hypotheticalEntry.entry, target, t.channel);
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
      upstreamDistTag: t.channel,
      writes: [
        `${LEDGER_RELATIVE}：releases[${upstreamDsh}].builds 追加 1 条（n=${planned.n}）`,
        'package.json / Cargo.toml：version ← 合成号（复用 version.mjs writeVersion）',
        'Cargo.lock：cargo update --workspace --offline 刷新（生成物，失败为软提示）',
      ],
      delegates: [
        `步骤⑤ 更新 lock：node scripts/prepare-harness.mjs --target ${target} --update-lockfile`,
        `步骤⑧ 补丁适用性：node ${PATCH_APPLICABILITY_SCRIPT}`,
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
 * 步骤⑧：补丁适用性（子进程，**不** import——它有自己的 CLI 语义与自测）。
 *
 * @param {string} root - 仓库根。
 * @returns {{ ok: boolean, detail: string }}
 */
export function runPatchApplicability(root = process.cwd()) {
  const result = spawnSync(process.execPath, [resolve(root, PATCH_APPLICABILITY_SCRIPT)], {
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
  const missing = planSync({ target: 'alpha', upstreamDsh: '0.2.2-alpha.1', ledger: base });
  eq('核算：锚点未动的上游前进必须判红（不静默新建键）', missing.plan, null);
  const noCounter = planSync({ target: 'alpha', upstreamDsh: '0.2.1-alpha.1', ledger: base, noCounter: true });
  eq('核算：--no-counter 不推 n', noCounter.plan.mode, 'no-counter');

  // 🔴 步骤①②的降级必须**显式可见**（§7.1 规则 3）——静默跳过 = 伪造成功。
  const skipped = verifyUpstreamRelease('v0.2.1-alpha.1', null);
  eq('步骤①②：未配 slug ⇒ skipped 且带显式说明', [skipped.status, skipped.notices.length > 0], ['skipped', true]);
  eq('步骤①②：skipped 不产生 problem（它不是失败，是已声明的降级）', skipped.problems, []);

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
  --upstream-repo <slug>    可选：上游 GitHub 仓库（启用步骤①②硬检查）
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
  const upstreamRepo = at('--upstream-repo') ?? null;

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

  // 步骤①②：上游 Release（可选硬检查；缺省显式降级）。
  const release = verifyUpstreamRelease(`v${upstreamDsh}`, upstreamRepo);
  problems.push(...release.problems);
  notices.push(...release.notices);

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
  const { entry, problems: entryProblems } = buildLedgerEntry({ target, upstreamDsh, n: plan.n, w, upstreamCommit: release.commit });
  if (entryProblems.length > 0 || entry === null) {
    for (const problem of entryProblems) console.error(`❌ ${problem}`);
    return 1;
  }
  const versionFiles = [join(process.cwd(), 'package.json'), join(process.cwd(), 'Cargo.toml')];
  const snapshot = snapshotFiles([ledgerPath(), ...versionFiles]);
  console.log(`📸 快照：${snapshot.dir}`);

  const newLedger = withLedgerEntry(ledger, upstreamDsh, entry, target, t.channel);
  writeFileSync(ledgerPath(), `${JSON.stringify(newLedger, null, 2)}\n`, 'utf8');
  console.log(`✅ 步骤⑥⑨：台账 ${LEDGER_RELATIVE} 追加 n=${plan.n}${release.commit ? `，回填 upstreamCommit` : ''}`);

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

  const patches = runPatchApplicability();
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
