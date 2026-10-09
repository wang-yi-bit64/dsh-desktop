#!/usr/bin/env node
/**
 * release-ledger.mjs — 已发布构建的**台账**（唯一产地，D4 定案）。
 *
 * ## 它记什么
 *
 * 本仓的桌面版本号是**合成号**（见 `docs/adr/061-synthetic-version-model.md`）：
 *
 * ```
 * <上游精确 x.y.z>-<上游预发布>.<n>[+<w>]
 * ```
 *
 * 其中 `<n>` 的含义是「在**同一个上游版本**上，本仓第几次对外交付」。`n` **不由人填**——
 * 它从台账推出来（`n = max(该组的 n) + 1`；见 `docs/version-policy.md` §3.2）。
 * 因此台账是「谁有权决定版本号」这条链路上的一环：人只决定**什么时候**发一版。
 *
 * ## 🔴 为什么台账必须显式存 `upstreamDsh`，不能靠解析桌面号反推
 *
 * 这两个版本号**形状同构**（三段 + 两段预发布标识符）：
 *
 * | 版本号 | 上游 | 本仓序号 |
 * |---|---|---|
 * | `0.7.3-alpha.1` | `0.7.3-alpha.1`（历史遗留，合成号机制**之前**） | **无** |
 * | `0.2.1-alpha.1.3` | `0.2.1-alpha.1` | `3` |
 *
 * 仅凭桌面号，**无法**判断末段标识符是**上游自己的**还是**本仓追加的**。
 * ⇒ **上游身份的唯一产地是台账的 `upstreamDsh` 字段**。{@link splitRepoSequence}
 * 只做「**已知**合成号」的拆解（用于校验），**不得**用于「从 tag 反推上游」。
 *
 * ## 它住在哪
 *
 * `harness-locks/dsh-releases.json`（D4 定案：**不新开第三个 lock 目录**）。
 * 各目标的 `inputs.json` 记「组装输入」，本台账记「发布事实」，两者不互相覆盖。
 *
 * ## 🔴 职责边界（2e 拆分，2026-10-09）
 *
 * 本文件与 `scripts/dsh-targets.mjs` 的分工是**互斥**的，别让职责回涨：
 *
 * | 归属 | 唯一产地 | 它回答的问题 |
 * |---|---|---|
 * | 运行时**目标表** | `scripts/dsh-targets.mjs` | 目标键 → 目录（`patches/` `packages/`）、上游锚点 `dshVersion`、桌面后缀 `publishChannel`、`upstreamDistTag`（仅发现）、`status` |
 * | 上游精确版本的**索引与台账** | 本文件 + `harness-locks/dsh-releases.json` | 「上游**精确**版本 → `patchTarget` + `status`」（{@link resolveReleaseFor}）、「本仓序号 `n` 与 `w`」（{@link planNextDesktopVersion}）、合成号（{@link composeDesktopVersion}）、发布通道（{@link deriveReleaseChannel}） |
 *
 * 两侧都**不**持有对方的字段：目标表不认识 `n` / `builds[]`；台账不存 `releaseChannel`
 * 的副本（由 `patchTarget` 现算）。`dsh-targets.mjs` 是**被**依赖方，本文件**单向**依赖它
 * （只为取 `publishChannel`）——反向 import 会让「目录契约」与「发布事实」互相绑定。
 *
 * ## CLI
 *
 * ```
 * node scripts/release-ledger.mjs --show        显示台账与下一个 n
 * node scripts/release-ledger.mjs --validate    校验台账自洽性（同一权威判据）
 * node scripts/release-ledger.mjs --self-test   纯逻辑自测（含可证伪夹具）
 * ```
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DSH_TARGETS, parseVersionShape } from './dsh-targets.mjs';

/** 台账在仓库内的相对路径（唯一产地：别处不许再拼这个字符串）。 */
export const LEDGER_RELATIVE = 'harness-locks/dsh-releases.json';

/** 台账格式版本。结构变更时递增，并让 {@link readLedger} 对旧版显式报错。 */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * 台账绝对路径。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {string} 台账文件路径。
 */
export function ledgerPath(root = process.cwd()) {
  return join(root, LEDGER_RELATIVE);
}

/**
 * 读取台账。
 *
 * 读不到 / 格式不对时**抛错**，不返回空台账——一个「静默当成空」的台账会让
 * 守卫永远绿（本仓缺陷族：扫描器坏了与真的没有东西，长得一模一样）。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {{ schemaVersion: number, releases: Record<string, {patchTarget: string,
 *   upstreamDistTag: string, status: string, builds: object[]}> }} 台账内容。
 * @throws {Error} 文件缺失、JSON 不可解析、`schemaVersion` 不符或 `releases` 非对象时。
 */
export function readLedger(root = process.cwd()) {
  const file = ledgerPath(root);
  if (!existsSync(file)) {
    throw new Error(
      `台账不存在：${LEDGER_RELATIVE}（相对 ${root}）。` +
        `它是「本仓第几次交付」的唯一产地，缺失时无法推导 n——不要用「当成空台账」蒙过去。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`台账 ${LEDGER_RELATIVE} 不是合法 JSON：${error.message}`);
  }
  if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `台账 schemaVersion 是 ${JSON.stringify(parsed.schemaVersion)}，` +
        `本脚本只认 ${LEDGER_SCHEMA_VERSION}。结构变更须同时改两端。`,
    );
  }
  if (parsed.releases === null || typeof parsed.releases !== 'object' || Array.isArray(parsed.releases)) {
    throw new Error(
      `台账 ${LEDGER_RELATIVE} 的 releases 必须是「精确上游版本 → 条目」的对象。` +
        `裸的 builds[] 数组不再是合法形状——本仓序号必须**按上游精确版本分组**，` +
        `而分组键就是这里的键（否则要在一个字段里重复记录上游身份，两份值会漂）。`,
    );
  }
  return parsed;
}

/**
 * 把按键索引的台账摊平成构建列表，并把**上游键**附着到每条记录上（`upstreamDsh`）。
 *
 * 为什么是「附着」而不是「存两份」：上游身份的唯一产地是**索引的键**。若在每条
 * `builds[]` 记录里再存一份 `upstreamDsh`，两份值可以漂而无人发现。这里在**读取时**
 * 由键派生，判据函数因此仍能按组工作。
 *
 * @param {{releases: Record<string, {builds: object[]}>}} ledger - 台账内容。
 * @returns {object[]} 每条记录都带 `upstreamDsh`（= 它的索引键）。
 */
export function allBuilds(ledger) {
  const out = [];
  for (const [upstreamDsh, entry] of Object.entries(ledger.releases)) {
    for (const build of entry.builds ?? []) out.push({ ...build, upstreamDsh });
  }
  return out;
}

/**
 * 拆分一个**已知是合成号**的版本，取出上游基址与折本仓序号。
 *
 * `0.2.1-alpha.1.3` → `{ base: '0.2.1-alpha.1', n: 3 }`。
 *
 * 🔴 **不得用于「从 tag 反推上游」**：`0.7.3-alpha.1` 会得到
 * `{ base: '0.7.3-alpha', n: 1 }`，而真实上游是 `0.7.3-alpha.1`、本仓**无**序号。
 * 两种形状同构，无从区分（详见模块文档）。上游身份只认台账的 `upstreamDsh`。
 *
 * @param {string} version - 版本号（可带前导 `v` 与 `+w`）。
 * @returns {{ ok: true, base: string, n: number, w: string|null, stableLine: boolean }
 *   | { ok: false, reason: string }} 拆解结果；末段标识符不是纯数字时 `ok: false`。
 */
export function splitRepoSequence(version) {
  const shape = parseVersionShape(version);
  if (!shape.ok) return { ok: false, reason: '不是合法 semver 形状' };
  if (shape.prerelease === null) {
    return { ok: false, reason: '没有预发布段：合成号的 <n> 落在预发布段里' };
  }
  const parts = shape.prerelease.split('.');
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last)) {
    return { ok: false, reason: `预发布段的末标识符 ${JSON.stringify(last)} 不是纯数字` };
  }
  if (last.length > 1 && last.startsWith('0')) {
    return { ok: false, reason: `序号 ${JSON.stringify(last)} 有前导零（版本号里禁止）` };
  }
  const rest = parts.slice(0, -1);
  const core = `${shape.major}.${shape.minor}.${shape.patch}`;
  return {
    ok: true,
    base: rest.length > 0 ? `${core}-${rest.join('.')}` : core,
    n: Number(last),
    w: shape.build,
    // 上游无预发布段时，本仓序号成了**唯一**的预发布标识符（`0.2.1-1`）。
    // 该载体仍是开口，见 ADR-061 决策 7。
    stableLine: rest.length === 0,
  };
}

/**
 * 合成一个桌面版本号。
 *
 * @param {string} upstreamDsh - 上游精确版本（如 `0.2.1-alpha.1`）。
 * @param {number} n - 本仓序号（正整数）。
 * @param {string|null} [w] - 可选人读标签（`[0-9A-Za-z-]+`，禁 `_`）。
 * @returns {string} 如 `0.2.1-alpha.1.3`；给了 `w` 则追加 `+w`。
 * @throws {Error} 上游版本非法、`n` 不是正整数、或 `w` 字符集不合法时。
 */
export function composeDesktopVersion(upstreamDsh, n, w = null) {
  const shape = parseVersionShape(upstreamDsh);
  if (!shape.ok) throw new Error(`上游版本不是合法 semver：${JSON.stringify(upstreamDsh)}`);
  if (shape.build !== null) {
    throw new Error(`上游版本不应带 build 段：${JSON.stringify(upstreamDsh)}（build 是塞不进合成号的）`);
  }
  if (shape.prerelease === null) {
    // 这里必须守：合成号 = `<上游含预发布>.<n>`，上游无预发布段时本仓序号**无载体**——
    // 直接拼接会产出 `0.2.1.1` 这种**四段式**，构建期即死（tauri-codegen 写死三段解析）。
    // 该开口是 ADR-061 决策 7；在唯一产地拦住，`planNextDesktopVersion` 之外的所有调用方（含 --apply）同样受保护。
    throw new Error(
      `上游 ${upstreamDsh} 是正式线（无预发布段），本仓序号无载体：直接拼接会产出四段式 ${upstreamDsh}.${n}。` +
        `该开口见 ADR-061 决策 7——落地 stable 目标前必须先定载体规则。`,
    );
  }
  if (!Number.isInteger(n) || n < 1) throw new Error(`本仓序号必须是 ≥1 的整数，收到 ${JSON.stringify(n)}`);
  if (w !== null && w !== undefined && w !== '') {
    if (!/^[0-9A-Za-z-]+$/.test(String(w))) {
      throw new Error(`w 标签只允许 [0-9A-Za-z-]，收到 ${JSON.stringify(w)}（下划线不合法）`);
    }
    return `${upstreamDsh}.${n}+${w}`;
  }
  return `${upstreamDsh}.${n}`;
}

/**
 * 校验单条台账记录的字段与自洽性。
 *
 * 自洽的核心是：`desktopVersion` 必须**逐字**等于由 `(上游键, n, w)` 合成出来的串。
 * 少了这条，「台账里的 n」与「版本号里的 n」可以各说各话而无人发现。
 *
 * ⚠️ 记录里**不存** `upstreamDsh`：它由构建列表的读取器从**索引的键**附着
 * （见 {@link allBuilds}）。存两份会让两份值漂而无人发现。
 *
 * @param {object} build - 一条台账记录（含读取器附着的 `upstreamDsh`）。
 * @param {number} index - 它在所属 `builds[]` 里的下标（报错定位用）。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function validateBuild(build, index) {
  const problems = [];
  const at = `${LEDGER_RELATIVE} releases[${build.upstreamDsh}].builds[${index}]`;
  const required = ['channel', 'n', 'desktopVersion', 'tag', 'date'];
  for (const field of required) {
    if (build[field] === undefined || build[field] === null || build[field] === '') {
      problems.push(`${at}：缺字段 ${field}`);
    }
  }
  if (!build.upstreamDsh) {
    problems.push(`${at}：上游键为空——记录必须挂在某个精确上游版本下`);
    return problems;
  }
  if (problems.length > 0) return problems;

  const expectedTag = `v${build.desktopVersion}`;
  if (build.tag !== expectedTag) {
    problems.push(`${at}：tag 是 ${JSON.stringify(build.tag)}，但 desktopVersion 要求 ${JSON.stringify(expectedTag)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(build.date))) {
    problems.push(`${at}：date 必须是 YYYY-MM-DD，收到 ${JSON.stringify(build.date)}`);
  }
  const shape = parseVersionShape(build.upstreamDsh);
  if (!shape.ok) {
    problems.push(`${at}：上游键不是合法 semver：${JSON.stringify(build.upstreamDsh)}`);
    return problems;
  }
  try {
    const composed = composeDesktopVersion(build.upstreamDsh, build.n, build.w ?? null);
    if (composed !== build.desktopVersion) {
      problems.push(`${at}：desktopVersion 与 (上游键, n, w) 不自洽——应为 ${composed}，实为 ${build.desktopVersion}`);
    }
  } catch (error) {
    problems.push(`${at}：${error.message}`);
  }
  return problems;
}

/**
 * 台账的**结构性不变量**：已发布构建不得共享 `(upstreamDsh, n)` 二元组。
 *
 * 这就是 `version-policy.md` §7.1 的**守卫 1**。因为 `desktopVersion` 由该二元组加
 * 可选 `w` 决定，重复的二元组意味着**两个不同的发布声称自己是同一版**——updater 的
 * 版本比较会把它们视为同一版，其中一个永远推不出去。
 *
 * @param {object[]} builds - 台账记录。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function findDuplicateSequences(builds) {
  const problems = [];
  const seen = new Map();
  builds.forEach((build, index) => {
    const key = `${build.upstreamDsh}\u0000${build.n}`;
    if (seen.has(key)) {
      problems.push(
        `已发布构建共享 (上游, n) = (${build.upstreamDsh}, ${build.n})：` +
          `builds[${seen.get(key)}] 与 builds[${index}]。` +
          `合成号由该二元组唯一决定 ⇒ 两次发布声称同一版，其中一个永远推不出去（守卫 1）。`,
      );
    } else {
      seen.set(key, index);
    }
  });
  return problems;
}

/**
 * `n` 在**同一上游版本内**必须是从 `1` 起、**无空洞**的连续序列。
 *
 * 理由：`n` 度量的是「在同一个上游版本上，本仓对外交付了几次」（§2.2）。交付过第 3 次
 * 就意味着交付过第 1、2 次——序列里出现空洞只有两种解释：**台账漏记**，或**某次发布的
 * 记录被删**。两者都会让「下一个 n」算错，从而**复用**一个已发布的序号（守卫 1 的
 * 「重复」只是这个错误的**事后形态**，空洞是它的**事前形态**，所以要单独判）。
 *
 * @param {object[]} builds - 台账记录。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function findSequenceGaps(builds) {
  const problems = [];
  const groups = new Map();
  for (const build of builds) {
    if (!groups.has(build.upstreamDsh)) groups.set(build.upstreamDsh, []);
    groups.get(build.upstreamDsh).push(Number(build.n));
  }
  for (const [upstreamDsh, ns] of groups) {
    const sorted = [...ns].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        problems.push(
          `上游 ${upstreamDsh} 的 n 序列有空洞：期望从 1 起连续，实为 [${sorted.join(', ')}]。` +
            `n 度量「第几次交付」⇒ 交付过第 ${sorted[i]} 次就必须交付过前 ${sorted[i] - 1} 次；` +
            `空洞意味着台账漏记或记录被删，会让「下一个 n」算错并复用已发布序号。`,
        );
        break;
      }
    }
  }
  return problems;
}

/**
 * 推导某个上游版本下的**下一个** `n`。
 *
 * 规则：`n = max(该上游版本的既有 n) + 1`；该上游版本首次交付时为 `1`
 * （`version-policy.md` §1.2-2：上游前进 ⇒ `n` 归 1）。
 *
 * @param {object[]} builds - 台账记录。
 * @param {string} upstreamDsh - 上游精确版本。
 * @returns {number} 下一个序号（≥1）。
 */
export function nextSequenceFor(builds, upstreamDsh) {
  const used = builds
    .filter((build) => build.upstreamDsh === upstreamDsh)
    .map((build) => Number(build.n))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

/**
 * 为一个「即将发布的上游版本」推导桌面版本号。**纯函数**，喂夹具即可证伪。
 *
 * @param {object} input
 * @param {object[]} input.builds - 台账记录。
 * @param {string} input.upstreamDsh - 上游精确版本（含其预发布段）。
 * @param {string|null} [input.w] - 可选人读标签。
 * @returns {{ desktopVersion: string, n: number, upstreamDsh: string }}
 * @throws {Error} 上游是**正式线**（无预发布段）时——该载体仍是开口（ADR-061 决策 7）。
 */
export function planNextDesktopVersion({ builds, upstreamDsh, w = null }) {
  const shape = parseVersionShape(upstreamDsh);
  if (!shape.ok) throw new Error(`上游版本不是合法 semver：${JSON.stringify(upstreamDsh)}`);
  if (shape.prerelease === null) {
    throw new Error(
      `上游 ${upstreamDsh} 是**正式线**（无预发布段），本仓序号无载体：` +
        `0.2.1-<n> 会让合成号的首个预发布标识符变成纯数字，通道解析随之失效。` +
        `该开口见 ADR-061 决策 7——落地 stable 目标时须先定规则，不得在此静默产出。`,
    );
  }
  const n = nextSequenceFor(builds, upstreamDsh);
  return { desktopVersion: composeDesktopVersion(upstreamDsh, n, w), n, upstreamDsh };
}

/**
 * 由 `patchTarget` **现算**本仓发布通道（计划 §4.4 规则 2：next 线 ⇒ `rc`，alpha 线 ⇒ `alpha`）。
 *
 * 为什么是「现算」而不是在台账里存一个 `releaseChannel` 字段：它是
 * `DSH_TARGETS[patchTarget].publishChannel` 的**纯函数**。存第二份只会让两份值**
 * 可以漂而无人发现**——与「`builds[]` 不存 `upstreamDsh`」是同一条理由
 * （台账 `$comment` 里记了这条对计划 §4.6 2b 字段清单的偏离及依据）。
 *
 * @param {string} patchTarget - 目录键（目标名）。
 * @param {Record<string, {publishChannel?: string}>} [targets] - 目标总表；默认 {@link DSH_TARGETS}。
 * @returns {string|null} 如 `rc` / `alpha`；目标名不存在或缺 `publishChannel` 时 `null`。
 */
export function deriveReleaseChannel(patchTarget, targets = DSH_TARGETS) {
  const target = targets[patchTarget];
  if (target === undefined) return null;
  const channel = target.publishChannel;
  return typeof channel === 'string' && channel !== '' ? channel : null;
}

/**
 * 台账里某目标的**在役**上游精确版本键（2h 起作为「本仓钉的是哪个上游版本」的 SSOT）。
 *
 * 「上游 `x.y.z` 的唯一产地」是**台账**（`docs/version-policy.md` §4）——目标表那侧的
 * `dshVersion` 只是**组装锚点**（它答「用哪套补丁目录」）。两者本应由
 * {@link checkIndexAgainstTargets} 钉在一起，但那一条只断言「目标表的锚点在台账里
 * **存在**且 `patchTarget` 对得上」，**不排除**台账里同时挂着同一目标的**第二个**在役键
 * （锚点已前移、旧键忘了置 `dormant`）。那时「文档该写哪个上游版本」就没有唯一定论，
 * 而每个守卫都可以各自挑一个默默通过——正是「枚举不全 = 假绿」的温床。
 * ⇒ 本函数把「该目标的在役键」显式化，让「不唯一」成为一个可判定的状态。
 *
 * ⚠️ 返回顺序是**字典序**（`sort()` 默认），**不是**版本新旧：`0.2.0-rc.10` 会排在
 * `0.2.0-rc.3` 前面。调用方只在「恰好一条」时才把它当权威值；多条时应当报错而不是
 * 拿 `[0]` 当答案。
 *
 * @param {Record<string, {patchTarget?: string, status?: string}>} releases - 台账索引。
 * @param {string} target - 目标名（`next` / `alpha`）。
 * @returns {string[]} 在役键（字典序）；空数组 = 该目标在台账里没有在役条目
 *   （**不是**「通过」——缺在役条目意味着「本仓钉的是哪个上游版本」无从回答）。
 */
export function inServiceUpstreamKeys(releases, target) {
  const out = [];
  for (const [key, entry] of Object.entries(releases ?? {})) {
    if (entry?.patchTarget !== target) continue;
    if (entry?.status !== 'active') continue;
    out.push(key);
  }
  return out.sort();
}

/**
 * **唯一入口**：「上游**精确**版本 → 该用哪套补丁 + 本仓下一个序号」。
 *
 * 这是 2e（2026-10-09）**迁到台账侧**的那部分职责。拆分后的分工：
 *   · `scripts/dsh-targets.mjs` 只答「目标键 → 目录 / 上游锚点 / 桌面后缀」；
 *   · 本函数答「上游精确版本 → `patchTarget` + 已有几次交付」——因为台账的**键就是**
 *     上游精确版本，计数由 `builds[]` 现算。`dsh-targets.mjs` **不能**回答这个，
 *     它连 `n` 都不认识（越界即职责回涨，见该模块文档的职责边界表）。
 *
 * ⚠️ **为什么未知版本是抛错、不是返回 `null`**：返回 `null` 会让调用方有机会「回退默认
 * 目标」，而那正是 2i 修掉的缺陷形态（`0.2.0.3-rc.1` 静默按 `next` 组装、产物看起来正常）。
 * 抛错把「查不到」与「查到了」变成两种**不可混淆**的形态，调用方没有第三个可以静默吞掉的分支。
 *
 * ⚠️ **计数必须走 `allBuilds()`**：`builds[]` 里**不存** `upstreamDsh`（上游身份的唯一产地
 * 是索引键），而 {@link nextSequenceFor} 按 `upstreamDsh` 过滤 ⇒ 直接喂 `entry.builds`
 * 会过滤掉全部记录、**恒返回 1**（静默算错 n）。台账里有一条专门的夹具钉住这一点。
 *
 * @param {{releases: Record<string, {patchTarget?: string, upstreamDistTag?: string,
 *   status?: string, builds?: object[]}>}} ledger - 台账内容。
 * @param {string} upstreamDsh - 上游**精确**版本（含上游自己的预发布段，如 `0.2.0-rc.2`）。
 * @returns {{upstreamDsh: string, patchTarget: string|undefined, upstreamDistTag: string|undefined,
 *   status: string|undefined, nextSequence: number, releaseChannel: string|null, builds: object[]}}
 *   解析结果；`releaseChannel` 由 `patchTarget` **现算**（台账刻意不存该字段）。
 * @throws {Error} 版本为空、或该精确版本不在台账索引里时。
 */
export function resolveReleaseFor(ledger, upstreamDsh) {
  const key = String(upstreamDsh ?? '').trim();
  if (key.length === 0) {
    throw new Error(
      'resolveReleaseFor：上游精确版本不能为空——台账键就是它，缺了无法选出 patchTarget。',
    );
  }
  const entry = ledger?.releases?.[key];
  if (entry === undefined) {
    throw new Error(
      `台账 ${LEDGER_RELATIVE} 里没有上游精确版本 ${JSON.stringify(key)} 这个键。` +
        `「用哪套补丁 / 已交付几次」只能由台账回答（键 = 上游精确版本）；` +
        `补登键要走 scripts/sync-upstream-release.mjs，**不得**在此回退默认目标。`,
    );
  }
  const builds = entry.builds ?? [];
  return {
    upstreamDsh: key,
    patchTarget: entry.patchTarget,
    upstreamDistTag: entry.upstreamDistTag,
    status: entry.status,
    nextSequence: nextSequenceFor(allBuilds(ledger), key),
    releaseChannel: entry.patchTarget === undefined ? null : deriveReleaseChannel(entry.patchTarget),
    builds,
  };
}

/**
 * **索引层**的非空化校验：台账必须**覆盖所有在役目标**，且映射方向自洽。
 *
 * 为什么必须单独有这一条：`builds[]` 全为空时，其余守卫全部**空转**（没有可断言的对象）。
 * 索引层只要有一条真实键就能被证伪，因此它是「守卫到底在不在查」的判据。
 *
 * @param {Record<string, {patchTarget: string, status: string}>} releases - 台账索引。
 * @param {Record<string, {dshVersion: string, status: string, publishChannel?: string}>} targets
 *   - 目标总表（`DSH_TARGETS`）。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkIndexAgainstTargets(releases, targets) {
  const problems = [];
  for (const [name, target] of Object.entries(targets)) {
    if (target.status !== 'active') continue;
    const entry = releases[target.dshVersion];
    if (entry === undefined) {
      problems.push(
        `在役目标 ${name} 的锚点是 ${target.dshVersion}，但台账里没有这个键。` +
          `台账是「这个精确上游版本用哪套补丁」的唯一产地（计划 2b）⇒ 缺键意味着` +
          `「补丁集没登记」或「台账没跟上锚点」，两者都会让组装取错 patchTarget。`,
      );
      continue;
    }
    if (entry.patchTarget !== name) {
      problems.push(
        `台账 ${target.dshVersion} 的 patchTarget 是 ${JSON.stringify(entry.patchTarget)}，` +
          `但在役目标 ${name} 的锚点正是该版本 ⇒ 应为 ${JSON.stringify(name)}。` +
          `两者不一致会让 patches/ 取到另一个目标的补丁集。`,
      );
    }
    // 台账**刻意不存** releaseChannel（它由 patchTarget 现算）⇒ 这条派生是通道的唯一来源。
    // 目标缺 publishChannel 时必须在这一层现形，否则发布侧拿到一个 undefined 通道而无提示。
    if (deriveReleaseChannel(name, targets) === null) {
      problems.push(
        `在役目标 ${name} 没有可用的 publishChannel ⇒ 无法由 patchTarget 现算 releaseChannel` +
          `（计划 §4.4 规则 2）。台账不存该字段，所以这条派生是**唯一**通道来源。`,
      );
    }
  }
  // 反向：键不得指向不存在的目标名（拼错的目标名会静默取不到补丁目录）。
  for (const [upstreamDsh, entry] of Object.entries(releases)) {
    if (entry.patchTarget !== undefined && targets[entry.patchTarget] === undefined) {
      problems.push(
        `台账键 ${upstreamDsh} 的 patchTarget 是 ${JSON.stringify(entry.patchTarget)}，` +
          `但目标总表里没有这个名字（可用：${Object.keys(targets).join(' / ')}）。`,
      );
    }
  }
  return problems;
}

/**
 * 台账的**整体**校验：索引层 + 记录层 + 守卫 1（重复 + 空洞）。
 *
 * ⚠️ **本函数刻意不读 `package.json`**。曾试过用「当前版本是不是合成号形状」来决定
 * 要不要断言「当前版本必须在台账里」——那是**错的触发条件**：`0.7.3-alpha.1`
 * （合成号机制之前的历史版本，本仓无序号）与 `0.2.1-alpha.1.3`（真正的合成号）
 * **形状同构**，{@link splitRepoSequence} 无法区分（详见模块文档）⇒ 该写法会让
 * 全部历史版本假红。正确做法是**显式传入**「我要发布的那个版本」，
 * 见 {@link checkLedgerAgainstVersion}。
 *
 * @param {object} input
 * @param {{releases: Record<string, object>}} input.ledger - 台账内容。
 * @param {Record<string, object>} input.targets - 目标总表（`DSH_TARGETS`）。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkLedger({ ledger, targets }) {
  const problems = [];
  problems.push(...checkIndexAgainstTargets(ledger.releases, targets));
  const builds = allBuilds(ledger);
  builds.forEach((build, index) => problems.push(...validateBuild(build, index)));
  problems.push(...findDuplicateSequences(builds));
  problems.push(...findSequenceGaps(builds));
  return problems;
}

/**
 * 断言**即将发布的那个版本**已在台账里（守卫 1 的**非空化**判据）。
 *
 * 为什么需要它：「台账为空」与「守卫根本没在查」长得一模一样（本仓纪律：扫出数为 0
 * 时先怀疑扫描器）。这里由发布流程**显式**把「我要发的版本」传进来，判据因此不依赖
 * 任何形状推断，不受历史版本同构问题影响。
 *
 * 调用点：`release.yml` preflight 与 `version:next` 的收尾自检。
 *
 * @param {object} input
 * @param {{releases: Record<string, object>}} input.ledger - 台账内容。
 * @param {string} input.version - 即将发布的桌面版本号。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkLedgerAgainstVersion({ ledger, version }) {
  const split = splitRepoSequence(version);
  if (!split.ok) {
    return [
      `待发布版本 ${version} 不是合成号形状（${split.reason}）。` +
        `合成号形如 <上游精确 x.y.z>-<上游预发布>.<n>[+<w>]；见 docs/version-policy.md §1.1。`,
    ];
  }
  if (allBuilds(ledger).some((build) => build.desktopVersion === version)) return [];
  return [
    `待发布版本 ${version} 不在台账里。合成号的 n 只能由台账推导 ⇒ 走到这一步说明` +
      `「这一版没有经过派生流程」，或台账漏记（守卫 1 的非空化判据）。`,
  ];
}

/**
 * 纯逻辑自测（含可证伪夹具）。不读磁盘、不联网。
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

  // 合成与拆解互为逆运算（合成号时代）。
  eq('合成：alpha.1 + n=3', composeDesktopVersion('0.2.1-alpha.1', 3), '0.2.1-alpha.1.3');
  eq('合成：带 w', composeDesktopVersion('0.2.1-alpha.1', 3, 'w1'), '0.2.1-alpha.1.3+w1');
  eq('合成：rc.3 + n=1', composeDesktopVersion('0.2.0-rc.3', 1), '0.2.0-rc.3.1');
  eq('拆解：alpha.1.3', splitRepoSequence('0.2.1-alpha.1.3').base, '0.2.1-alpha.1');
  eq('拆解：拆出的 n', splitRepoSequence('0.2.1-alpha.1.3').n, 3);
  eq('拆解：带 w 时 w 被单独取到', splitRepoSequence('0.2.1-alpha.1.3+w1').w, 'w1');
  eq('拆解：非合成号（末段不是数字）判 false', splitRepoSequence('0.2.1-alpha.rc').ok, false);
  eq('拆解：无预发布段判 false', splitRepoSequence('0.2.1').ok, false);
  eq('拆解：前导零判 false', splitRepoSequence('0.2.1-alpha.1.03').ok, false);

  // 🔴 可伪证夹具：形状同构 ⇒ 不得从桌面号反推上游。
  //    这是模块文档里那条警告的可执行形态：若有人给 splitRepoSequence 加上
  //    「末段数字一定是本仓序号」的信任，`0.7.3-alpha.1` 就会把 base 说成
  //    `0.7.3-alpha`（一个上游从未发布过的版本）。
  eq('同构：0.7.3-alpha.1 拆出的 base 是 0.7.3-alpha（**不是**真实上游）', splitRepoSequence('0.7.3-alpha.1').base, '0.7.3-alpha');
  eq('同构：它拆出的 n 是 1（**不是**本仓序号）', splitRepoSequence('0.7.3-alpha.1').n, 1);
  eq(
    '同构：两个来源不同的版本号拆出相同形状 ⇒ 上游只能靠台账',
    [splitRepoSequence('0.7.3-alpha.1').base === '0.7.3-alpha.1', splitRepoSequence('0.2.1-alpha.1.3').base === '0.2.1-alpha.1.3'],
    [false, false],
  );
  eq('稳定线载体被标出', splitRepoSequence('0.2.1-1').stableLine, true);
  eq('稳定线：base 退化成裸核心', splitRepoSequence('0.2.1-1').base, '0.2.1');

  // 字段校验：desktopVersion 必须与 (upstreamDsh, n, w) 自洽。
  const goodBuild = {
    channel: 'alpha',
    n: 1,
    w: 'w1',
    desktopVersion: '0.2.1-alpha.1.1+w1',
    upstreamDsh: '0.2.1-alpha.1',
    tag: 'v0.2.1-alpha.1.1+w1',
    date: '2026-10-08',
  };
  eq('记录：合法记录零 problem', validateBuild(goodBuild, 0), []);
  eq(
    '记录：desktopVersion 与 n 打架必须报红',
    validateBuild({ ...goodBuild, desktopVersion: '0.2.1-alpha.1.2+w1' }, 0).length > 0,
    true,
  );
  eq('记录：tag 与 desktopVersion 不一致必须报红', validateBuild({ ...goodBuild, tag: 'v0.2.1-alpha.1.2' }, 0).length > 0, true);
  eq('记录：缺字段必须报红', validateBuild({ ...goodBuild, tag: '' }, 0).some((p) => p.includes('缺字段 tag')), true);
  eq('记录：date 形状必须校验', validateBuild({ ...goodBuild, date: '2026/10/08' }, 0).length > 0, true);

  // 守卫 1：二元组不得重复。
  const dup = [goodBuild, { ...goodBuild, w: 'w2', desktopVersion: '0.2.1-alpha.1.1+w2', tag: 'v0.2.1-alpha.1.1+w2' }];
  eq(
    '守卫 1：同一 (上游, n) 出现两次必须报红',
    findDuplicateSequences(dup).some((p) => p.includes('守卫 1')),
    true,
  );
  eq('守卫 1：同一上游不同 n 合法', findDuplicateSequences([goodBuild, { ...goodBuild, n: 2, desktopVersion: '0.2.1-alpha.1.2+w1', tag: 'v0.2.1-alpha.1.2+w1' }]).length, 0);
  eq('守卫 1：不同上游同 n 合法', findDuplicateSequences([goodBuild, { ...goodBuild, upstreamDsh: '0.2.2-alpha.1', desktopVersion: '0.2.2-alpha.1.1+w1', tag: 'v0.2.2-alpha.1.1+w1' }]).length, 0);

  // 守卫 1 的**事前形态**：n 序列不得有空洞。
  eq('空洞：n=[1] 合法', findSequenceGaps([goodBuild]), []);
  eq('空洞：n=[1,2] 合法', findSequenceGaps([goodBuild, { ...goodBuild, n: 2 }]), []);
  eq('空洞：n=[2] 必须报红（缺 1）', findSequenceGaps([{ ...goodBuild, n: 2 }]).length > 0, true);
  eq('空洞：n=[1,3] 必须报红（缺 2）', findSequenceGaps([goodBuild, { ...goodBuild, n: 3 }]).length > 0, true);
  eq(
    '空洞：分组独立——两个上游各有 [1] 合法',
    findSequenceGaps([goodBuild, { ...goodBuild, upstreamDsh: '0.2.2-alpha.1' }]),
    [],
  );
  eq(
    '空洞：报错必须点明是哪条上游序列',
    findSequenceGaps([{ ...goodBuild, n: 2 }]).some((p) => p.includes('0.2.1-alpha.1')),
    true,
  );

  // n 的推导：按上游分组，不跨组。
  eq('推导：首个上游版本 → n=1', nextSequenceFor([], '0.2.1-alpha.1'), 1);
  eq('推导：已有 n=1 → n=2', nextSequenceFor([goodBuild], '0.2.1-alpha.1'), 2);
  eq('推导：已有 n=1,3 → n=4（取 max 而非计数）', nextSequenceFor([goodBuild, { ...goodBuild, n: 3 }], '0.2.1-alpha.1'), 4);
  eq(
    '推导：别的上游版本的 n 不参与（上游前进 ⇒ 归 1）',
    nextSequenceFor([goodBuild, { ...goodBuild, n: 9 }], '0.2.2-alpha.1'),
    1,
  );
  eq(
    '推导：上游预发布段前进也归 1（alpha.1 → alpha.2）',
    nextSequenceFor([{ ...goodBuild, n: 7 }], '0.2.1-alpha.2'),
    1,
  );

  // 端到端：从台账推出下一个版本号。
  eq('计划：空台账 → 首个合成号', planNextDesktopVersion({ builds: [], upstreamDsh: '0.2.1-alpha.1' }).desktopVersion, '0.2.1-alpha.1.1');
  eq(
    '计划：已有 n=1 → .2（w 须显式传，不由旧记录继承）',
    planNextDesktopVersion({ builds: [goodBuild], upstreamDsh: '0.2.1-alpha.1', w: 'w1' }).desktopVersion,
    '0.2.1-alpha.1.2+w1',
  );
  eq(
    '计划：不传 w 则无标签（不继承上一条的 w）',
    planNextDesktopVersion({ builds: [goodBuild], upstreamDsh: '0.2.1-alpha.1' }).desktopVersion,
    '0.2.1-alpha.1.2',
  );

  // 🔴 正式线必须**显式拒绝**，不得静默产出 `0.2.1-1` / `0.2.1.1`（ADR-061 决策 7 的开口）。
  //    这条守在**合成函数**（唯一产地）本身：`planNextDesktopVersion` 之外的所有调用方同样受保护。
  throws('计划：正式线上游必须抛错（ADR-061 决策 7）', () => planNextDesktopVersion({ builds: [], upstreamDsh: '0.2.1' }));
  throws('合成：正式线上游必须抛错（直接拼接会产出四段式 0.2.1.1）', () => composeDesktopVersion('0.2.1', 1));
  throws('合成：n 必须是正整数', () => composeDesktopVersion('0.2.1-alpha.1', 0));
  throws('合成：w 禁下划线', () => composeDesktopVersion('0.2.1-alpha.1', 1, 'w_1'));
  throws('合成：上游不得带 build 段', () => composeDesktopVersion('0.2.1-alpha.1+x', 1));

  // 台账：按**精确上游版本**为键的索引 + 组内 builds[]。
  // ⚠️ 夹具必须带 `publishChannel`：索引层用它**现算** releaseChannel（台账不存该字段）。
  //    这正是那条守卫的用处——夹具少一个字段，它就会红（而不是静默拿到 undefined）。
  const TARGETS = {
    next: { dshVersion: '0.2.0-rc.2', status: 'active', publishChannel: 'rc' },
    alpha: { dshVersion: '0.2.1-alpha.1', status: 'active', publishChannel: 'alpha' },
  };
  const ledgerOf = (releases) => ({ schemaVersion: 1, releases });
  const fullLedger = ledgerOf({
    '0.2.0-rc.2': { patchTarget: 'next', upstreamDistTag: 'next', status: 'active', builds: [] },
    '0.2.1-alpha.1': { patchTarget: 'alpha', upstreamDistTag: 'alpha', status: 'active', builds: [goodBuild] },
  });


  // === 2e（2026-10-09）：台账侧唯一入口 =====================================
  // 「上游**精确**版本 → patchTarget + 下一个 n」。这是从目标表**迁过来**的职责：
  // 目标表只知道目录与锚点，不认识 n，也不认识台账。
  const ledger2e = ledgerOf({
    '0.2.1-alpha.1': {
      patchTarget: 'alpha',
      upstreamDistTag: 'alpha',
      status: 'active',
      builds: [
        { channel: 'alpha', n: 1, desktopVersion: '0.2.1-alpha.1.1', tag: 'v0.2.1-alpha.1.1', date: '2026-10-08' },
        { channel: 'alpha', n: 2, desktopVersion: '0.2.1-alpha.1.2', tag: 'v0.2.1-alpha.1.2', date: '2026-10-09' },
      ],
    },
    '0.2.0-rc.2': {
      patchTarget: 'next',
      upstreamDistTag: 'next',
      status: 'active',
      builds: [
        { channel: 'rc', n: 7, desktopVersion: '0.2.0-rc.2.7', tag: 'v0.2.0-rc.2.7', date: '2026-10-09' },
      ],
    },
  });
  const resolvedAlpha = resolveReleaseFor(ledger2e, '0.2.1-alpha.1');
  eq('2e：精确版本 → patchTarget', resolvedAlpha.patchTarget, 'alpha');
  eq('2e：精确版本 → upstreamDistTag（仅发现）', resolvedAlpha.upstreamDistTag, 'alpha');
  eq('2e：builds 原样带出', resolvedAlpha.builds.length, 2);
  // 🔴 这条钉住一个**静默算错**的实现：把 `entry.builds`（不带 upstreamDsh）直接喂给
  //    nextSequenceFor ⇒ 过滤不到任何记录 ⇒ 恒返回 1。期望 3（组内 max 2 + 1）。
  eq('2e：下一个 n = 组内 max+1（**不是** 1）', resolvedAlpha.nextSequence, 3);
  eq('2e：releaseChannel 由 patchTarget 现算', resolvedAlpha.releaseChannel, 'alpha');
  // 🔴 跨组不得污染：next 组的 n=7 ⇒ 下一个 8；若实现用了「全局 max」会得到 3。
  const resolvedRc = resolveReleaseFor(ledger2e, '0.2.0-rc.2');
  eq('2e：计数按上游精确版本分组，不跨组污染', resolvedRc.nextSequence, 8);
  eq('2e：next 线的 releaseChannel 是 rc（其上游 dist-tag 却是 next）', resolvedRc.releaseChannel, 'rc');
  eq('2e：此处两字段确实不同（解耦的证明）', resolvedRc.upstreamDistTag !== resolvedRc.releaseChannel, true);
  // 🔴 未知版本必须**抛错**，不得返回 `null` 让调用方回退默认目标——那正是 2i 的同类形态。
  throws('2e：台账无此精确版本必须抛错', () => resolveReleaseFor(ledger2e, '9.9.9-alpha.1'));
  throws('2e：空版本必须抛错', () => resolveReleaseFor(ledger2e, '   '));
  // 上游正式线（无预发布段）在本仓尚无载体（ADR-061 决策 7）⇒ 台账里没有该键，同样抛错。
  throws('2e：上游正式线版本未登记 ⇒ 抛错（决策 7 的开口）', () => resolveReleaseFor(ledger2e, '0.2.2'));

  // === 2h（2026-10-09）：在役键 = 「本仓钉的是哪个上游版本」的 SSOT ==========
  // 目标表的 `dshVersion` 只答「用哪套补丁目录」；文档要写的上游版本由这里给出。
  // 期望值**硬编码**（不得由被测函数现算，否则「返回全部键」与「只返回一个」都会过）。
  eq('2h：在役键唯一时给出那一条', inServiceUpstreamKeys(ledger2e.releases, 'alpha'), ['0.2.1-alpha.1']);
  eq('2h：next 的在役键', inServiceUpstreamKeys(ledger2e.releases, 'next'), ['0.2.0-rc.2']);
  eq('2h：没有该目标的键 ⇒ 空数组（不是「通过」）', inServiceUpstreamKeys(ledger2e.releases, 'stable'), []);
  // 🔴 核心判据：同一目标挂**两个**在役键时必须都返回（调用方据此报「不唯一」），
  //    若实现只取第一条，「锚点已前移、旧键忘了置 dormant」就会静默挑一个通过。
  eq(
    '2h：同一目标两个在役键必须**都**返回（否则「不唯一」无从发现）',
    inServiceUpstreamKeys(
      ledgerOf({
        '0.2.0-rc.2': { patchTarget: 'next', status: 'active' },
        '0.2.0-rc.3': { patchTarget: 'next', status: 'active' },
      }).releases,
      'next',
    ),
    ['0.2.0-rc.2', '0.2.0-rc.3'],
  );
  eq(
    '2h：dormant 的键不算在役',
    inServiceUpstreamKeys(
      ledgerOf({
        '0.2.0-rc.2': { patchTarget: 'next', status: 'dormant' },
        '0.2.0-rc.3': { patchTarget: 'next', status: 'active' },
      }).releases,
      'next',
    ),
    ['0.2.0-rc.3'],
  );
  eq(
    '2h：patchTarget 是别的目标 ⇒ 不算本目标在役',
    inServiceUpstreamKeys(ledgerOf({ '0.2.0-rc.2': { patchTarget: 'alpha', status: 'active' } }).releases, 'next'),
    [],
  );
  eq('2h：空台账 ⇒ 空数组（不抛错，调用方按「缺在役条目」处理）', inServiceUpstreamKeys({}, 'next'), []);

  eq('索引：覆盖所有在役目标 → 通过', checkIndexAgainstTargets(fullLedger.releases, TARGETS), []);  eq(
    '索引：**漏掉一个在役目标的键**必须报红（这是空转的解法）',
    checkIndexAgainstTargets(ledgerOf({ '0.2.0-rc.2': { patchTarget: 'next', status: 'active' } }).releases, TARGETS).some((p) =>
      p.includes('alpha'),
    ),
    true,
  );
  eq(
    '索引：patchTarget 指错目标必须报红',
    checkIndexAgainstTargets(
      ledgerOf({ '0.2.1-alpha.1': { patchTarget: 'next', status: 'active' } }).releases,
      { alpha: { dshVersion: '0.2.1-alpha.1', status: 'active', publishChannel: 'alpha' } },
    ).length > 0,
    true,
  );
  eq(
    '索引：patchTarget 指向不存在的目标名必须报红',
    checkIndexAgainstTargets(
      ledgerOf({ '0.2.1-alpha.1': { patchTarget: 'beta', status: 'active' } }).releases,
      TARGETS,
    ).some((p) => p.includes('没有这个名字')),
    true,
  );
  eq('索引：休眠目标不要求有键', checkIndexAgainstTargets(ledgerOf({}).releases, { next: { dshVersion: '9.9.9', status: 'dormant' } }), []);

  // releaseChannel：由 patchTarget **现算**（台账刻意不存该字段——见文件 `$comment` 里的偏离说明）。
  // 两条理由性夹具：① 目标名不存在；② 目标存在但没有 `publishChannel`（派生会拿到 undefined）。
  eq('通道：next 目标 → rc', deriveReleaseChannel('next', TARGETS), 'rc');
  eq('通道：alpha 目标 → alpha', deriveReleaseChannel('alpha', TARGETS), 'alpha');
  eq('通道：未知目标名 → null', deriveReleaseChannel('beta', TARGETS), null);
  eq('通道：目标缺 publishChannel → null', deriveReleaseChannel('x', { x: { dshVersion: '1.0.0', status: 'active' } }), null);
  eq(
    '通道（接线）：目标缺 publishChannel 必须在索引层现形',
    checkIndexAgainstTargets({ '1.0.0': { patchTarget: 'x' } }, { x: { dshVersion: '1.0.0', status: 'active' } }).some((p) =>
      p.includes('publishChannel'),
    ),
    true,
  );

  // allBuilds：上游身份由**索引键**附着，记录里不存第二份。
  eq('摊平：上游键被附着到记录上', allBuilds(fullLedger)[0].upstreamDsh, '0.2.1-alpha.1');
  eq('摊平：builds 为空也是合法满覆盖', allBuilds(ledgerOf({ '0.2.1-alpha.1': { builds: [] } })).length, 0);

  // 整体校验：索引 + 记录 + 守卫 1。
  eq('校验：合法满覆盖台账内部一致', checkLedger({ ledger: fullLedger, targets: TARGETS }), []);
  eq(
    '校验：空 builds 但覆盖在役目标 → 内部一致（空集不冒充失败）',
    checkLedger({ ledger: ledgerOf({ '0.2.0-rc.2': { patchTarget: 'next', status: 'active' }, '0.2.1-alpha.1': { patchTarget: 'alpha', status: 'active' } }), targets: TARGETS }),
    [],
  );
  eq(
    '校验：重复二元组必须报红',
    checkLedger({ ledger: ledgerOf({ '0.2.1-alpha.1': { patchTarget: 'alpha', status: 'active', builds: dup } }), targets: { alpha: { dshVersion: '0.2.1-alpha.1', status: 'active', publishChannel: 'alpha' } } }).length > 0,
    true,
  );

  // 非空化判据（显式传入待发布版本）：不依赖任何形状推断。
  const ledgered = ledgerOf({
    '0.2.1-alpha.1': {
      patchTarget: 'alpha',
      status: 'active',
      builds: [{ ...goodBuild, w: undefined, desktopVersion: '0.2.1-alpha.1.1', tag: 'v0.2.1-alpha.1.1' }],
    },
  });
  const empty = ledgerOf({ '0.2.1-alpha.1': { patchTarget: 'alpha', status: 'active', builds: [] } });
  eq('非空化：待发布版本在台账里 → 通过', checkLedgerAgainstVersion({ ledger: ledgered, version: '0.2.1-alpha.1.1' }), []);
  eq('非空化：待发布版本不在台账里必须报红', checkLedgerAgainstVersion({ ledger: empty, version: '0.2.1-alpha.1.1' }).length > 0, true);
  eq(
    '非空化：真正非合成号（无预发布段）必须报「形状」错',
    checkLedgerAgainstVersion({ ledger: empty, version: '0.2.1' }).some((p) => p.includes('不是合成号形状')),
    true,
  );
  eq(
    '非空化：四段式等非法形状也走形状错',
    checkLedgerAgainstVersion({ ledger: empty, version: '0.2.1.3-rc.1' }).some((p) => p.includes('不是合成号形状')),
    true,
  );
  // 🔴 可伪证夹具：这正是「形状推断」不可靠的**第三次**现形。
  //    `0.7.3-alpha.1` 是历史遗留（本仓无序号），但形状上**通过了**合成号判据，
  //    于是它落到「不在台账里」这一支——合成号时代这本就该被拒，只是**理由不同**。
  //    ⇒ 判据只能断言「在不在台账里」，不得声称「已确认它是合成号」。
  eq(
    '歧义：历史形态在形状判据上会通过（故只能报「不在台账里」）',
    checkLedgerAgainstVersion({ ledger: empty, version: '0.7.3-alpha.1' }).some((p) => p.includes('不在台账里')),
    true,
  );
  eq(
    '歧义：它**不会**被报成形状错（形状对它无能为力）',
    checkLedgerAgainstVersion({ ledger: empty, version: '0.7.3-alpha.1' }).some((p) => p.includes('不是合成号形状')),
    false,
  );
  // 🔴 可伪证夹具：这正是「用形状推断触发条件」会踩的那一脚。
  //    两个版本号形状同构，但一个是历史遗留、一个是合成号；显式传入才能区分。
  eq(
    '同构补充：历史形态 0.7.3-alpha.1 在形状判据上**通过**（故不得靠形状推断）',
    splitRepoSequence('0.7.3-alpha.1').ok,
    true,
  );

  if (failures.length > 0) {
    throw new Error(`release-ledger 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `release-ledger.mjs — 已发布构建台账（${LEDGER_RELATIVE}）

  --show                  显示台账与各上游组的下一个 n
  --validate [--version v] 校验台账内部一致性；给了 --version 则连带断言该版本已在台账里
  --self-test             纯逻辑自测
  --help                  显示本帮助`;

/**
 * CLI 主入口。
 *
 * @param {string[]} args - `process.argv.slice(2)`。
 * @returns {number} 退出码（0 成功 / 1 校验失败 / 2 用法错误）。
 */
function main(args) {
  if (args.includes('--help') || args.length === 0) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ release-ledger 自测通过（${passed} 项）`);
    return 0;
  }
  const ledger = readLedger();
  if (args.includes('--validate')) {
    const problems = checkLedger({ ledger, targets: DSH_TARGETS });
    // 显式传入待发布版本时，连带跑非空化判据（发布流程的用法）。
    const at = args.indexOf('--version');
    if (at !== -1 && args[at + 1]) {
      problems.push(...checkLedgerAgainstVersion({ ledger, version: args[at + 1] }));
    }
    // ⚠️ 空集是**合法**状态（合成号机制尚无发布），但必须**显式说出来**——
    //    否则「没有可断言的东西」会被读成「已断言且通过」（§7.1 规则 3：禁止无声降级）。
    //    索引层（覆盖在役目标）已非空转，故这里说的是 builds[] 那一层的空集状态。
    const builds = allBuilds(ledger);
    if (builds.length === 0) {
      console.warn(
        `⚠️  台账 builds[] 为空：合成号机制（ADR-061）尚无发布 ⇒ 守卫 1（二元组不重复 / n 序列无空洞）` +
          `当前是**空集判据**。这不是通过，是没有可断言的对象。` +
          `（索引层非空转：已核对 ${Object.keys(ledger.releases).length} 个上游键覆盖在役目标。）`,
      );
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`❌ ${problem}`);
      return 1;
    }
    console.log(`✅ 台账自洽（${Object.keys(ledger.releases).length} 个上游键，${builds.length} 条构建记录）`);
    return 0;
  }
  if (args.includes('--show')) {
    const entries = Object.entries(ledger.releases);
    console.log(`台账 ${LEDGER_RELATIVE}（schemaVersion ${ledger.schemaVersion}，${entries.length} 个上游键）：`);
    if (entries.length === 0) {
      console.log('  （空——没有任何上游精确版本被登记）');
    }
    for (const [upstream, entry] of entries) {
      const builds = entry.builds ?? [];
      const ns = builds.map((b) => b.n).sort((a, b) => a - b);
      const used = ns.length === 0 ? '（尚无构建）' : `已用 n = ${ns.join(', ')}`;
      console.log(
        `  ${upstream.padEnd(16)} patchTarget=${String(entry.patchTarget).padEnd(6)} ` +
          `distTag=${String(entry.upstreamDistTag).padEnd(6)} ${used}    下一个 n = ${nextSequenceFor(allBuilds(ledger), upstream)}`,
      );
    }
    return 0;
  }
  console.error(`未知参数：${args.join(' ')}\n${USAGE}`);
  return 2;
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
