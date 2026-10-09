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
 * ## 🌉 `bridges[]`：桥接版（→ ADR-063）
 *
 * 合成号有一个**换代的断崖**：本仓历史版本号跑到过 `0.7.3-alpha.1`，而合成号跟随上游，
 * 只在 `0.2.x`。两者一比就是**降级**（实测 `compareSemver('0.2.1-alpha.1.1','0.7.3-alpha.1') = -1`）
 * ⇒ 已安装的客户端按 updater 默认判据（`release > current`）**永远不会收到**合成号。
 *
 * 处置是**桥接版（bridge）**：先按旧模型发一个**更高**的版本号，它内置
 * `plugins.updater.allowDowngrades = true`（比较器从「必须更新」放宽成「必须不同」）；
 * 用户装上它之后，才能接收排序更低的合成号。`bridges[]` 就是这段**已发生的历史事实**
 * 的机器可读台账——它不承担排序，只回答两个问题：
 *
 *   ① **构建期**：这个版本号是不是桥接版？是 ⇒ `.updater-config.json` 里写 `allowDowngrades: true`
 *      （产地唯一：`updater-manifest.mjs::isBridgeVersion`，靠读本文件判断）。
 *   ② **守卫期**：单调守卫与更新端点守卫要不要**豁免**排序要求？（见下面「豁免语义」）
 *
 * ```json
 * { "version": "0.7.3-rc.1", "tag": "v0.7.3-rc.1", "channel": "rc", "target": "next",
 *   "upstreamDsh": "0.2.0-rc.2", "relaxes": "allowDowngrades", "date": "2026-10-09", "why": "…" }
 * ```
 *
 * ### 豁免语义（只能由本文件回答，不得散落在守卫里）
 *
 * 「桥接已经发生」是**事实**，所以豁免必须建立在事实之上，而不是「版本号长得像桥接版」：
 *
 * | 判据 | 反例（必须判红） |
 * |---|---|
 * | 候选版本低于同通道最高 tag 时，**该通道**存在 `bridges[]` 记录且其 `version ≥ 该最高 tag` | 台账里没有该通道的桥接记录 ⇒ 判红 |
 * | 桥接记录必须**不是**合成号（它按定义是旧模型的号） | 把 `0.2.1-alpha.1.1` 登记成桥接版 ⇒ 判红 |
 * | 桥接的 `channel` 必须等于由 `target` 现算的 `publishChannel` | `target=alpha` 却写 `channel=rc` ⇒ 判红 |
 *
 * ⚠️ **豁免是长期的**（合成号会一直低于 `0.7.x` 的桥接号，直到上游越过它）。这是刻意的：
 * 桥接版一旦送达，投递就不再由排序决定；此后各通道内部的排序仍由「同通道最高 tag」逐次约束。
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
 * 两侧都**不**持有对方的字段：目标表不认识 `n` / `builds[]` / `bridges[]`；台账不存 `releaseChannel`
 * 的副本（由 `patchTarget` 现算）。`dsh-targets.mjs` 是**被**依赖方，本文件**单向**依赖它
 * （取 `publishChannel` 与「版本后缀 → 目标」的解析）——反向 import 会让「目录契约」与「发布事实」互相绑定。
 *
 * ## CLI
 *
 * ```
 * node scripts/release-ledger.mjs --show        显示台账、下一个 n、桥接版与 Release Plan
 * node scripts/release-ledger.mjs --validate    校验台账自洽性 + Release Plan **恒时**判据
 * node scripts/release-ledger.mjs --validate --strict-plan
 *                                               额外跑 Release Plan **时点**判据（决策时刻）
 * node scripts/release-ledger.mjs --add-bridge <版本> [--apply]
 *                                登记桥接版（默认只读；--apply 才写）
 * node scripts/release-ledger.mjs --self-test   纯逻辑自测（含可证伪夹具）
 * ```
 *
 * ## 🔴 Release Plan 的两组判据（恒时 / 时点）
 *
 * `release-manifest.json` 是**时点**文件（第 3 步的决策快照），而「`n` 等于台账现算的下一个」
 * 这条判据只在决策时刻为真。**恒时**判据（结构 / 目标 / 在役键唯一 / 字段白名单 / `w` 字符集）
 * 进每次门禁；**时点**判据进决策前门。理由与代价见 {@link diagnoseReleasePlan} 的 boxed 段。
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { compareSemver } from './conventional-commits.mjs';
import { DSH_TARGETS, channelOfPrerelease, parseVersionShape, targetForVersion } from './dsh-targets.mjs';

/** 台账在仓库内的相对路径（唯一产地：别处不许再拼这个字符串）。 */
export const LEDGER_RELATIVE = 'harness-locks/dsh-releases.json';

/** 台账格式版本。结构变更时递增，并让 {@link readLedger} 对旧版显式报错。 */
export const LEDGER_SCHEMA_VERSION = 2;

/** 桥接版当前**唯一**支持的放宽手段（`updater-manifest.mjs::isBridgeVersion` 的消费点）。 */
export const BRIDGE_RELAXATIONS = ['allowDowngrades'];

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
 *   upstreamDistTag: string, status: string, builds: object[]}>, bridges: object[] }} 台账内容。
 * @throws {Error} 文件缺失、JSON 不可解析、`schemaVersion` 不符、`releases` 非对象
 *   或 `bridges` 不是数组时。
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
  // schemaVersion 2 起 `bridges` 是**必填**（可为空数组）：省掉这个键与「忘了登记桥接版」
  // 在读取端长得一模一样，而两者的后果相反（一个合法、一个会让合成号被判红/被误豁免）。
  if (!Array.isArray(parsed.bridges)) {
    throw new Error(
      `台账 ${LEDGER_RELATIVE} 的 bridges 必须是数组（没有桥接版就写 []）。` +
        `它是「桥接版是否已发布」的唯一产地：单调守卫与更新端点守卫都靠它决定要不要豁免排序要求。` +
        `缺这个键 = 无法区分「确实没有桥接版」与「忘了登记」。`,
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
 * **桌面版本号 → 它由哪条桌面通道投递**（`publishChannel`，如 `rc` / `alpha`）。
 *
 * 与 {@link deriveReleaseChannel} 是**同一事实的两个入口**，分工按「手里有什么」划分：
 *
 * | 手里的东西 | 走哪个 | 谁在用 |
 * |-----------|--------|--------|
 * | 台账记录 / 目标名（`patchTarget`） | {@link deriveReleaseChannel} | 写盘面、台账校验 |
 * | 一个**版本号**（`package.json` 只有号，没有目标名） | 本函数 | 单调性豁免、更新清单校验 |
 *
 * 为什么需要它：桥接版豁免判据必须知道「候选版本走哪条通道」（各通道有自己的更新
 * 端点，别的通道的桥接版管不到这里的客户端）。而 `version.mjs` **刻意不**从
 * `dsh-targets.mjs` 取东西（该模块文档记了这条边界），通道推导因此留在台账侧。
 *
 * ⚠️ 两条**不静默**约定：
 *   · **正式版落默认目标**（`targetForVersion` 的既有语义：无预发布段 ⇒ `DEFAULT_TARGET`）
 *     ⇒ 本题下返回的是**默认目标的 `publishChannel`**（今天 = `rc`）。这与
 *     `updater-manifest.mjs::publishChannelForVersion` **同源同答**，因为它答的正是
 *     「这个版本会被哪条端点投递」——而端点确实是这么选出来的。**不要**把它换成
 *     `desktopChannelForVersion`（那个对正式版答 `'stable'`，答的是另一个问题：
 *     「这一版对外属于哪条通道」；`stable` 尚无目标载体，见 ADR-061 决策 7）；
 *   · 后缀不命中任何目标的 `publishChannel`（如 `beta`）⇒ 返回 `null`，
 *     **不**回落到默认目标——回落会让「这条号走哪条通道」变成一个猜出来的答案；
 *   · 形状非法 ⇒ 由 `dsh-targets.mjs::channelOfPrerelease` **抛错**（ADR-061 守卫 3：
 *     通道解析不许静默回落），本函数不 catch。
 *
 * @param {string} version - 桌面版本号（可带前导 `v` 与 `+w`）。
 * @returns {string|null} `publishChannel`；后缀不命中任何目标时为 `null`。
 * @throws {Error} 版本形状非法时（调用方须显式处理，不得当成 `null`）。
 */
export function releaseChannelOf(version) {
  const target = targetForVersion(version);
  return target === null ? null : deriveReleaseChannel(target);
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
 * 校验一条**桥接版**记录（`bridges[]` 的一项）。
 *
 * 判据全部是**可证伪**的（每条都配反例，见自测）：
 *   · 必填字段齐全，`tag` 逐字等于 `v<version>`；
 *   · `version` **不得**是**真合成号**——桥接版按定义是旧模型的号（它存在的意义正是
 *     「合成号比它低」），登记成合成号会让豁免判据失去意义；
 *   · `channel` 必须等于由 `target` 现算的 `publishChannel`（两处各说各话 = 豁免找错通道）；
 *   · `relaxes` 必须是已知放宽手段之一；
 *   · `upstreamDsh` 必须是台账里**已存在**的键（桥接版同样内置某个上游精确版本，
 *     记一个没登记过的上游 = 伪造身份）。
 *
 * 🔴 **「是不是真合成号」不能靠形状判**：`splitRepoSequence('0.7.3-rc.1')` 会**成功**
 * 并给出 `{base:'0.7.3-rc', n:1}` —— 旧模型的桥接号与合成号**形状同构**（本模块文档
 * 反复出现的那个陷阱）。判据因此是 **`split.base` 是否是一个台账键**（与
 * `version.mjs::explainComposite` 的 `baseIsKnown` 同一条纪律）：是 ⇒ 真合成号 ⇒ 判红。
 *
 * @param {object} bridge - 一条桥接版记录。
 * @param {number} index - 它在 `bridges[]` 里的下标（报错定位用）。
 * @param {Record<string, {publishChannel?: string, status?: string}>} [targets] - 目标总表。
 * @param {Record<string, object>} [releases] - 台账的 `releases` 索引（判「真合成号」用）。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function validateBridge(bridge, index, targets = DSH_TARGETS, releases = {}) {
  const problems = [];
  const at = `${LEDGER_RELATIVE} bridges[${index}]`;
  if (bridge === null || typeof bridge !== 'object' || Array.isArray(bridge)) {
    return [`${at}：必须是一个对象`];
  }
  for (const field of ['version', 'tag', 'channel', 'target', 'relaxes', 'date', 'upstreamDsh']) {
    const value = bridge[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      problems.push(`${at}：缺字段 ${field}`);
    }
  }
  if (problems.length > 0) return problems;

  const version = String(bridge.version).trim();
  if (bridge.tag !== `v${version}`) {
    problems.push(`${at}：tag 是 ${JSON.stringify(bridge.tag)}，但 version 要求 ${JSON.stringify(`v${version}`)}`);
  }
  const shape = parseVersionShape(version);
  if (!shape.ok) {
    problems.push(`${at}：version ${JSON.stringify(version)} 不是合法 semver`);
  } else {
    // 🔴 判「真合成号」的依据是**台账键**，不是形状（见函数文档的 boxed 说明）。
    const split = splitRepoSequence(version);
    if (split.ok && Object.prototype.hasOwnProperty.call(releases ?? {}, split.base)) {
      problems.push(
        `${at}：version ${JSON.stringify(version)} 拆出的基址 ${JSON.stringify(split.base)} **是台账里的键** ⇒ ` +
          `它是**真合成号**。桥接版按定义是旧模型的号（它存在的意义正是「合成号比它低」）⇒ ` +
          `登记成合成号会让豁免判据失去意义。合成号请走 releases[<上游键>].builds[]。`,
      );
    }
  }
  if (!BRIDGE_RELAXATIONS.includes(bridge.relaxes)) {
    problems.push(
      `${at}：relaxes 是 ${JSON.stringify(bridge.relaxes)}，已知放宽手段只有 ${BRIDGE_RELAXATIONS.join(' / ')}。` +
        `换一种放宽机制必须同时改 updater-manifest.mjs 的构建期消费点——不许只改台账。`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bridge.date))) {
    problems.push(`${at}：date 必须是 YYYY-MM-DD，收到 ${JSON.stringify(bridge.date)}`);
  }

  const target = targets[bridge.target];
  if (target === undefined) {
    problems.push(`${at}：target ${JSON.stringify(bridge.target)} 不在目标总表里（可用：${Object.keys(targets).join(' / ')}）`);
  } else {
    const expected = deriveReleaseChannel(bridge.target, targets);
    if (expected !== bridge.channel) {
      problems.push(
        `${at}：channel 是 ${JSON.stringify(bridge.channel)}，但 target ${bridge.target} 的 publishChannel 是 ` +
          `${JSON.stringify(expected)} ⇒ 豁免会去找错通道的桥接版。`,
      );
    }
  }
  if (shape.ok) {
    let suffix = null;
    try {
      suffix = channelOfPrerelease(version);
    } catch {
      suffix = null;
    }
    if (suffix !== null && suffix !== bridge.channel) {
      problems.push(
        `${at}：version ${JSON.stringify(version)} 的后缀推出通道 ${JSON.stringify(suffix)}，` +
          `与记录的 channel ${JSON.stringify(bridge.channel)} 不一致。`,
      );
    }
  }
  return problems;
}

/**
 * 该通道上「版本 ≥ `atLeast`」的桥接版记录，按版本**降序**（豁免判据的私有内核）。
 *
 * 只做「同通道 + 版本下界」这一层筛选，**不**问「它到底发出去了没有」——那一层是
 * {@link isPublished}，由调用方决定要不要用。拆开是为了让「登记了但没发布」能被
 * **说清楚**（见 {@link bridgeExemptionFor} 的 `bridge-not-delivered`），而不是和
 * 「压根没登记」混成同一个 `null`。
 *
 * @param {object} input
 * @param {object[]} [input.bridges] - 台账 `bridges[]`。
 * @param {string} input.channel - 通道名。
 * @param {string} input.atLeast - 版本下界。
 * @returns {object[]} 候选记录（降序；版本非法或缺失的记录被跳过）。
 */
function bridgesOnChannel({ bridges, channel, atLeast }) {
  const wanted = String(channel ?? '').trim();
  const floor = String(atLeast ?? '').trim();
  if (wanted.length === 0 || floor.length === 0) return [];
  const out = [];
  for (const bridge of bridges ?? []) {
    if (bridge === null || typeof bridge !== 'object') continue;
    if (bridge.channel !== wanted) continue;
    const version = String(bridge.version ?? '').trim();
    if (version.length === 0) continue;
    let cmp;
    try {
      cmp = compareSemver(version, floor);
    } catch {
      continue; // 脏记录：跳过（它会被 validateBridge 单独判红，不该在这里炸掉整趟判定）
    }
    if (cmp < 0) continue;
    out.push(bridge);
  }
  return out.sort((a, b) => compareSemver(String(b.version), String(a.version)));
}

/**
 * 某个版本是否**已经作为 tag 出现在语料里**（= 它真的发出去了）。
 *
 * 为什么这是豁免的必要条件：台账里的一条 `bridges[]` 记录只是**意图书**，
 * 把它当成「已经送达用户」是伪造事实。豁免的全部前提是「用户手里那个版本已经放宽了
 * 比较器」——只有 tag 存在才谈得上这件事。
 *
 * 比较用**规范化后的字符串相等**（两侧都剥掉前导 `v`）：tag 由本仓按 `v<version>` 生成，
 * 这里不是版本比较，是「这条号在不在语料里」的集合判定。
 *
 * @param {string[]} [tags] - tag 语料。
 * @param {string} version - 版本号。
 * @returns {boolean} 是否已发布。
 */
function isPublished(tags, version) {
  const wanted = String(version ?? '').trim();
  if (wanted.length === 0) return false;
  for (const tag of tags ?? []) {
    if (String(tag ?? '').trim().replace(/^v/i, '') === wanted) return true;
  }
  return false;
}

/**
 * 找出**允许候选版本低于** `atLeast` 的桥接版记录（豁免判据的**唯一产地**）。
 *
 * 语义：某通道的最高已发布 tag 是 `atLeast`。若该通道存在桥接版且它的版本 ≥ `atLeast`，
 * 说明「比它低的合成号」已经能通过放宽后的比较器送达用户 ⇒ 排序要求对该通道失效。
 *
 * ⚠️ 三条都**必须**成立，且都不许放宽：
 *   · **同通道**——每个桌面通道有自己的更新端点，别的通道的桥接版管不到这里的客户端；
 *   · **bridge.version ≥ atLeast**——若桥接版本身就比已知最高 tag 低，那它当年根本没送达，
 *     豁免就变成「用一个没生效的机制绕过守卫」；
 *   · **`v<bridge.version>` 已在 tag 语料里**——台账记录只是**意图**。少了这一条，
 *     一条「登记了但永不发布」的记录就能永久给出豁免，而这正是最该被拦下的形态
 *     （豁免在跑、客户端其实收不到）。因此 `tags` 缺失时**一律不豁免**：
 *     无凭据不等于默认成立。
 *
 * 「最高一条」在**已送达**的候选里取：否则一条永不发布的高号会永久压过真正生效的那条。
 *
 * @param {object} input
 * @param {object[]} input.bridges - 台账 `bridges[]`。
 * @param {string} input.channel - 候选版本所属通道（`rc` / `alpha`）。
 * @param {string} input.atLeast - 需要被「压过」的版本（通常是该通道最高已发布 tag）。
 * @param {string[]} [input.tags] - 已发布 tag 语料（**不给 ⇒ 不豁免**）。
 * @returns {{version: string, channel: string, relaxes: string} | null} 命中最高的一条记录，或 `null`。
 */
export function findPermittingBridge({ bridges, channel, atLeast, tags }) {
  for (const candidate of bridgesOnChannel({ bridges, channel, atLeast })) {
    if (isPublished(tags, candidate.version)) return candidate;
  }
  return null;
}

/**
 * 某通道上**已发布的最高版本**（`通道 → 版本` 的**唯一产地**）。
 *
 * 为什么它在台账侧而不是 git 侧：更新投递的判据是**按通道**的（每个通道有自己的滚动
 * Release 与 `latest.json`），因此「这条通道最高发到过哪一版」是通道事实，不是版本号事实。
 * `dsh-targets.mjs::desktopChannelForVersion` 答「这一版属于哪条通道」，本函数答
 * 「这条通道到过哪」，两者合起来才够用作豁免的比较基准。
 *
 * ⚠️ **这是语料扫描，不是版本校验**（与 `updater-manifest.mjs::newestTagFrom` 同一纪律，
 * 本函数就是它的实现产地）：
 *   · 脏元素（`vNext`、`batch-2026`、空串、四段式）**跳过**，绝不让它抛错——
 *     `git tag --list 'v*'` 里任一脏 tag 都不该让整趟核对失败，也不该把
 *     「扫描器坏了」与「投递真的断了」混成同一个报错；
 *   · 已知的**单个**版本号走 `channelOfPrerelease`（形状非法**必须**抛错，ADR-061 守卫 3）。
 *     两者是**同一个输入的两种意图**，结果相反且都必须如此，自测里各有一条钉住。
 *
 * @param {string[]} tags - tag 语料（可带前导 `v`）。
 * @param {string} channel - 通道名（= 目标的 `publishChannel`）。
 * @returns {string|null} 版本号（**不含**前导 `v`）；该通道无匹配时为 `null`。
 */
export function newestPublishedForChannel(tags, channel) {
  const wanted = String(channel ?? '').trim();
  if (wanted.length === 0) return null;
  let best = null;
  for (const tag of tags ?? []) {
    const raw = String(tag ?? '').trim();
    if (raw.length === 0) continue;
    if (!parseVersionShape(raw).ok) continue; // 脏 tag：跳过，不由它决定通道
    let suffix;
    try {
      suffix = channelOfPrerelease(raw);
    } catch {
      continue; // 形状判据与 channelOfPrerelease 不一致时也按脏元素跳过
    }
    if (suffix !== wanted) continue;
    const version = raw.replace(/^v/i, '');
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  return best;
}

/**
 * 桥接版豁免的**完整判定**：给定一个候选版本，说明「它能不能低于线上已有版本」。
 *
 * 这是豁免语义的唯一产地，返回的是**事实**而不是结论——判红与否由调用方决定
 * （`version.mjs` 把它降为 warning，`updater-manifest.mjs` 用它放行通道核对）。
 * 分开的理由：同一事实在两处的**出口**不同（一个是版本号守卫、一个是投递健康），
 * 但**判据必须只有一份**，否则两处会各有一套「什么算合格桥接版」。
 *
 * 判据（三条都必要，理由见 {@link findPermittingBridge}）：
 *   1. 候选版本的通道可判定（`releaseChannelOf`）；正式版 / 未知后缀 ⇒ 不可判定 ⇒ 不豁免；
 *   2. 该通道存在桥接版，且 `bridge.version ≥ 该通道已发布的最高版本`；
 *   3. 该桥接版的 tag **已在 `tags` 语料里**（= 它真的送达过）。台账登记只是**意图**，
 *      少了这一条，一条「登记了但永不发布」的记录就能永久给出豁免。
 *
 * ⚠️ 判据 2 里的基准是**同通道**最高版本，**不是全局最高**。原因不是放宽：
 * 每个通道有自己的端点，`rc` 的客户端从来收不到 `alpha` 的号，拿别的通道的最高号
 * 去要求本通道的桥接版只会得到一个永远不成立的豁免（`0.7.4-alpha.1` 会压死
 * `rc` 线上合格的 `0.7.3-rc.1`）——那是「守卫看起来在跑、其实永不生效」。
 *
 * @param {object} input
 * @param {string} input.version - 候选桌面版本号。
 * @param {string[]} [input.tags] - 已发布 `v*` tag 语料。
 * @param {object[]} [input.bridges] - 台账 `bridges[]`。
 * @returns {{granted: boolean, reason: string, channel: string|null, atLeast: string|null, bridge: object|null}}
 *   `reason` 取值：`bridge`（豁免成立）/ `unresolved-channel` / `no-tags-on-channel` /
 *   `no-bridge-on-channel` / `bridge-not-delivered`。**调用方不得把 `reason` 当错误码用**——
 *   它是给人读的依据。
 */
export function bridgeExemptionFor({ version, tags = [], bridges = [] }) {
  let channel = null;
  try {
    channel = releaseChannelOf(version);
  } catch {
    channel = null;
  }
  if (channel === null) {
    return {
      granted: false,
      reason: 'unresolved-channel',
      channel: null,
      atLeast: null,
      bridge: null,
    };
  }
  const atLeast = newestPublishedForChannel(tags, channel);
  if (atLeast === null) {
    return { granted: false, reason: 'no-tags-on-channel', channel, atLeast: null, bridge: null };
  }
  const bridge = findPermittingBridge({ bridges, channel, atLeast, tags });
  if (bridge === null) {
    // 有登记、但一条都没送达 ⇒ 与「压根没登记」区分开：前者是**发了一半**
    // （台账已改、tag 没打），后者是还没开始。两者的下一步动作不同。
    const registered = bridgesOnChannel({ bridges, channel, atLeast });
    return {
      granted: false,
      reason: registered.length > 0 ? 'bridge-not-delivered' : 'no-bridge-on-channel',
      channel,
      atLeast,
      bridge: null,
    };
  }
  return { granted: true, reason: 'bridge', channel, atLeast, bridge };
}

/**
 * 台账的**整体**校验：索引层 + 记录层 + 守卫 1（重复 + 空洞）+ 桥接版层。
 *
 * ⚠️ **本函数刻意不读 `package.json`**。曾试过用「当前版本是不是合成号形状」来决定
 * 要不要断言「当前版本必须在台账里」——那是**错的触发条件**：`0.7.3-alpha.1`
 * （合成号机制之前的历史版本，本仓无序号）与 `0.2.1-alpha.1.3`（真正的合成号）
 * **形状同构**，{@link splitRepoSequence} 无法区分（详见模块文档）⇒ 该写法会让
 * 全部历史版本假红。正确做法是**显式传入**「我要发布的那个版本」，
 * 见 {@link checkLedgerAgainstVersion}。
 *
 * @param {object} input
 * @param {{releases: Record<string, object>, bridges?: object[]}} input.ledger - 台账内容。
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

  const bridges = ledger.bridges ?? [];
  // ⚠️ 第 4 个参数（releases）**必须**传：它判「这条桥接版是不是登记成了真合成号」。
  //    漏传 ⇒ 该判据退化成空集（`releases = {}` ⇒ 任何记录都「不是台账键」）⇒
  //    「把合成号登记成桥接版」这一整类坏记录**静默通过**。
  bridges.forEach((bridge, index) => problems.push(...validateBridge(bridge, index, targets, ledger.releases)));
  // 同通道同版本登记两次 ⇒ 豁免判据的「最高一条」不再唯一（读的人不知道该信哪条）。
  const seen = new Map();
  bridges.forEach((bridge, index) => {
    const key = `${bridge?.channel}\u0000${bridge?.version}`;
    if (seen.has(key)) {
      problems.push(
        `${LEDGER_RELATIVE} bridges[${index}] 与 bridges[${seen.get(key)}] 是同通道同版本的桥接版记录 ⇒ ` +
          `豁免判据的「最高一条」不再唯一（同一事实两个产地）。`,
      );
    } else {
      seen.set(key, index);
    }
  });
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

// ---------------------------------------------------------------------------
// Release Plan（release-manifest.json）——步骤 3 的人工决策面
// ---------------------------------------------------------------------------

/** Release Plan 在仓库内的相对路径（唯一产地）。 */
export const PLAN_RELATIVE = 'release-manifest.json';

/**
 * Release Plan 的结构版本。
 *
 * 与 `LEDGER_SCHEMA_VERSION` 同一纪律：**必须有人查**。一个只被声明、从不被断言的
 * `schemaVersion` 比没有这个字段更坏——它长得像一道守卫，实际不拦任何东西（本仓缺陷族：
 * 「判据没查」与「判据通过」输出一样）。
 */
export const PLAN_SCHEMA_VERSION = 1;

/**
 * Release Plan 允许出现的**顶层**字段（闭合集合）。
 *
 * 同一纪律的另一半：只给 `lines` 的行内做字段白名单，顶层就留了后门——把 `lines` 打成
 * `line` 会被 `lines 必须是对象` 顺带拦住，但 `breakingg` 之类只会安静地待在那里，
 * 而**真正生效的那个默认值**没人看得见（读的人以为写的东西生效了）。
 *
 * `$comment` 是唯一为「给人看的说明」开的口（`harness-locks/dsh-releases.json` 同样用它）：
 * 不写说明的计划在换代/桥接这类场合会让人误读它的适用范围。
 */
export const PLAN_FIELDS = ['schemaVersion', 'releaseType', 'breaking', 'lines', '$comment'];

/** 四种 release 类型（`docs/version-policy.md` §3.2）。 */
export const RELEASE_TYPES = ['upstream', 'desktop-feature', 'desktop-fix', 'mixed'];

/**
 * 读取 Release Plan。
 *
 * 与 {@link readLedger} 同一纪律：读不到 / 格式不对**抛错**，不返回空计划——
 * 「计划为空」与「计划没读进来」长得一模一样，而后者会让第 4 步派生出一个**没人决策过**
 * 的版本号（§3.1：Release Plan 是链路上**唯一**的自由意志节点）。
 *
 * ⚠️ 它与 `MANIFEST.json` **不是一回事**：`MANIFEST.json` 是**发布证明**（产物里的事实），
 * 本文件是**发布计划**（发布前的决策）。名字相像，职责相反，不要互相代替。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {{schemaVersion: number, releaseType: string, breaking: boolean,
 *   lines: Record<string, {n: number, w: string|null}>}} 计划内容。
 * @throws {Error} 文件缺失、JSON 不可解析、缺 `releaseType` / `lines` 时。
 */
export function readReleasePlan(root = process.cwd()) {
  const file = join(root, PLAN_RELATIVE);
  if (!existsSync(file)) {
    throw new Error(
      `Release Plan 不存在：${PLAN_RELATIVE}（相对 ${root}）。` +
        `它是「这一次要发哪几条线、第几次交付」的唯一决策处，缺失时**不得**当作「没计划」继续派生版本号。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${PLAN_RELATIVE} 不是合法 JSON：${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PLAN_RELATIVE} 必须是一个 JSON 对象`);
  }
  return parsed;
}

/**
 * Release Plan 的**判据本体**（唯一产地）。所有出口都是它的投影。
 *
 * ## 为什么判据要分成「恒时」与「时点」两组
 *
 * `release-manifest.json` 是一份**时点**文件：第 3 步写下「这一次发哪几条线、第几次交付」，
 * 第 4 步据它派生版本号。发出去之后，台账的 `next n` 前进一格，**计划里的 `n` 立刻变成历史值**。
 *
 * 于是「`n` 必须逐字等于台账现算的下一个序号」这条判据**只在决策时刻成立**。
 * 把它放进每次 PR 都跑的门禁，只有两种收场：要么每个与发布无关的 PR 都要顺手改一个 `n`
 * （人会开始乱改），要么有人把判据删掉（判据消失）。两者都比没有判据坏。
 *
 * 因此拆成两组，**各自去它有意义的地方**：
 *
 * | 组 | 判据 | 何时为真 | 谁调用 |
 * |---|---|---|---|
 * | **恒时** | 1~6、8（结构 / 目标 / 在役键唯一 / 字段白名单 / `n` 形状 / `w` 字符集） | 永远 | `release-ledger --validate`（fast/ci/release 全档） |
 * | **时点** | 7（`n` 逐字等于台账现算的下一个） | 仅在决策时刻 | `sync-upstream-release --plan/--apply`（第 3→4 步）、`--validate --strict-plan` |
 *
 * 为什么恒时组也值得存在：它拦的正是「不重读仓库就写现状」那一族缺陷——目标名打错、
 * 写了已休眠的通道、把派生值（合成号）塞进计划、`w` 里写 `_`。这些与「发没发过」无关。
 *
 * ⚠️ 为什么必须与台账交叉校验（时点组）：ADR-061 明写 `n = 台账 builds[] 中同组 max(n) + 1`。
 * 若计划自说自话写一个 `n`，第 4 步派生出的版本号就可能与台账冲突，而那种冲突只在发布后、
 * 守卫 1 报红时才现形——那时 tag 已经推出去了。
 *
 * @param {object} input
 * @param {object} input.plan - 计划内容（{@link readReleasePlan} 的产物）。
 * @param {object} input.ledger - 台账内容。
 * @param {Record<string, object>} [input.targets] - 目标总表。
 * @param {boolean} [input.withSequence] - `true` 时**连带**跑时点判据 7（`n` == 台账现算值）。
 *   缺省 `false` = 只跑恒时判据（门禁用法）。**默认必须是恒时**：默认跑时点判据会让
 *   「随便哪个 PR 都红」，而红得没道理的门禁最后会被绕过去。
 * @returns {{problems: string[], notes: Array<{target: string, upstreamDsh: string|null,
 *   plannedN: number|null, nextN: number|null, w: string|null, withSequence: boolean,
 *   current: boolean|null}>}} `problems` 空数组 = 通过；`notes` 是**每行的推导事实**
 *   （恒时组也算得出），供 `--show` / `--validate` 打印「这条计划现在是当前值还是历史值」——
 *   调用方因此不必自己再推一遍（自己推 = `n` 出现第二个产地）。
 */
export function diagnoseReleasePlan({ plan, ledger, targets = DSH_TARGETS, withSequence = false }) {
  const problems = [];
  const notes = [];
  const at = PLAN_RELATIVE;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return { problems: [`${at}：必须是一个 JSON 对象`], notes };
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    problems.push(
      `${at}：schemaVersion 是 ${JSON.stringify(plan.schemaVersion)}，本脚本只认 ${PLAN_SCHEMA_VERSION}。` +
        `结构变更须同时改两端——否则读的人会按旧结构理解一份新结构的计划。`,
    );
  }
  for (const key of Object.keys(plan)) {
    if (!PLAN_FIELDS.includes(key)) {
      problems.push(
        `${at}：出现未知顶层字段 ${JSON.stringify(key)}（只允许 ${PLAN_FIELDS.join(' / ')}）。` +
          `打错字的字段会安静地不生效，而**真正生效的默认值**读的人看不见。`,
      );
    }
  }
  if (!RELEASE_TYPES.includes(plan.releaseType)) {
    problems.push(
      `${at}：releaseType 是 ${JSON.stringify(plan.releaseType)}，` +
        `四种类型只有 ${RELEASE_TYPES.join(' / ')}（docs/version-policy.md §3.2）。`,
    );
  }
  if (typeof plan.breaking !== 'boolean') {
    problems.push(`${at}：breaking 必须是布尔（收到 ${JSON.stringify(plan.breaking)}）`);
  }
  const lines = plan.lines;
  if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) {
    problems.push(`${at}：lines 必须是对象（键 = 目标名）`);
    return { problems, notes };
  }
  const names = Object.keys(lines);
  if (names.length === 0) {
    // 空集判据（AGENTS.md §7.3）：没有可派生的对象 ≠ 派生出零个版本是对的。
    problems.push(
      `${at}：lines 为空 ⇒ 没有任何线要发布。空集**不得**冒充通过——` +
        `若这次确实不发版，就不要走发布流程，而不是留一份空计划。`,
    );
    return { problems, notes };
  }
  const builds = allBuilds(ledger);
  for (const name of names) {
    const line = lines[name];
    const here = `${at} lines.${name}`;
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      problems.push(`${here}：必须是对象`);
      continue;
    }
    for (const key of Object.keys(line)) {
      if (key !== 'n' && key !== 'w') {
        problems.push(
          `${here}：出现未知字段 ${JSON.stringify(key)}（只允许 n / w）。` +
            `合成号本身**不在**计划里——它由第 4 步从台账派生，写进来就是第二个产地。`,
        );
      }
    }
    const target = targets[name];
    if (target === undefined) {
      problems.push(`${here}：目标 ${JSON.stringify(name)} 不在目标总表里（可用：${Object.keys(targets).join(' / ')}）`);
      continue;
    }
    if (target.status === 'dormant') {
      problems.push(`${here}：目标 ${name} 已裁定休眠，休眠通道不得发布（ADR-056 / ADR-057）。`);
      continue;
    }
    const inService = inServiceUpstreamKeys(ledger.releases, name);
    if (inService.length !== 1) {
      problems.push(
        `${here}：目标 ${name} 的在役上游键有 ${inService.length} 条（${inService.join(', ') || '无'}）——` +
          `计划必须绑定**恰好一个**上游精确版本，否则「这一版用哪套补丁」没有唯一定论。`,
      );
      continue;
    }
    const upstreamDsh = inService[0];
    const nextN = nextSequenceFor(builds, upstreamDsh);
    const note = {
      target: name,
      upstreamDsh,
      plannedN: Number.isInteger(line.n) ? line.n : null,
      nextN,
      w: line.w ?? null,
      withSequence,
      current: null,
    };
    if (!Number.isInteger(line.n) || line.n < 1) {
      problems.push(`${here}：n 必须是 ≥ 1 的整数（收到 ${JSON.stringify(line.n)}）`);
    } else if (withSequence && line.n !== nextN) {
      // 时点判据：只在决策时刻跑（`withSequence`）。
      problems.push(
        `${here}：n 是 ${line.n}，但台账里上游 ${upstreamDsh} 现算的下一个序号是 ${nextN}。` +
          `n **不由人填**（ADR-061）⇒ 计划与台账对不上时以台账为准，改计划。` +
          `（若这条线**已经发过**了第 ${line.n} 次，那本计划是历史快照，不该在决策时刻拿来派生版本号。）`,
      );
    } else if (Number.isInteger(line.n)) {
      // 恒时组照样算得出「当前 / 历史」——这不是判据，是**事实**，供打印用。
      // 少了它，读的人只能看到「计划里写着 n=1」，看不出那到底是下一个还是上一个。
      note.current = line.n === nextN;
    }
    if (line.w !== null && line.w !== undefined) {
      if (typeof line.w !== 'string' || !/^[0-9A-Za-z-]+$/.test(line.w)) {
        problems.push(
          `${here}：w 是 ${JSON.stringify(line.w)}，字符集必须是 [0-9A-Za-z-] 且非空` +
            `（§7.2 不变式：不许出现 \`_\`）。`,
        );
      }
    }
    notes.push(note);
  }
  return { problems, notes };
}

/**
 * **恒时**判据（门禁用法）：结构 / 目标 / 在役键唯一 / 字段白名单 / `n` 形状 / `w` 字符集。
 *
 * 断言 `n` **不**与台账现算值相等——那一条是时点判据，见下。
 *
 * @param {object} input 同 {@link diagnoseReleasePlan}（`withSequence` 被忽略）。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkReleasePlanStructure({ plan, ledger, targets = DSH_TARGETS }) {
  return diagnoseReleasePlan({ plan, ledger, targets, withSequence: false }).problems;
}

/**
 * **时点**判据（决策时刻用法）：恒时判据 **+** `n` 逐字等于台账现算的下一个序号。
 *
 * @param {object} input 同 {@link diagnoseReleasePlan}。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkReleasePlan({ plan, ledger, targets = DSH_TARGETS }) {
  return diagnoseReleasePlan({ plan, ledger, targets, withSequence: true }).problems;
}

/**
 * 第 3→4 步的**前门判据**：「这一次要发的这条线，计划批准的就是它」。
 *
 * 供 `sync-upstream-release.mjs` 在派生版本号**之前**调用——它是「计划 → 派生」这条链上
 * 唯一的强制点。少了它，`release-manifest.json` 就是一份没人读的文件（而它长得像决策面）。
 *
 * 判据：
 *   1. 计划里**有**这个目标的行（没有 = 这一次没批准发这条线 ⇒ 判红）；
 *   2. 行的 `n` 等于台账现算的下一个（时点判据）；
 *   3. 行的 `w` 与本次实际要用的 `w` 一致（`w` 是人读标签，但它**进版本号**：
 *      计划写 `w=batch` 而实际发 `w=null`，发出去的串与批准的不是同一个）。
 *
 * @param {object} input
 * @param {object} input.plan - 计划内容。
 * @param {object} input.ledger - 台账内容。
 * @param {string} input.target - 本次要发的目标。
 * @param {string|null} [input.w] - 本次实际要用的 `w`。
 * @param {Record<string, object>} [input.targets] - 目标总表。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkPlanLineFor({ plan, ledger, target, w = null, targets = DSH_TARGETS }) {
  const { problems, notes } = diagnoseReleasePlan({ plan, ledger, targets, withSequence: true });
  const line = plan?.lines?.[target];
  if (line === undefined) {
    problems.push(
      `${PLAN_RELATIVE} 里没有目标 ${target} 的行 ⇒ 这一次**没有**批准发布这条线。` +
        `第 3 步（出 Release Plan）必须先写这一行，第 4 步才允许派生它的版本号。`,
    );
    return problems;
  }
  const note = notes.find((n) => n.target === target);
  if (note === undefined) return problems; // 结构问题已在上面的 problems 里逐条报出
  const plannedW = note.w;
  if ((plannedW ?? null) !== (w ?? null)) {
    problems.push(
      `${PLAN_RELATIVE} lines.${target}.w 是 ${JSON.stringify(plannedW)}，而本次要用 ` +
        `${JSON.stringify(w ?? null)}。w **进版本号**（\`+w\`）⇒ 两者不一致时发出去的串不是计划批准的那一个。`,
    );
  }
  return problems;
}

/**
 * 把计划的一行**解出来**：目标 → 在役上游键 → 下一个 `n` → 合成号。
 *
 * 这是给人看的（`--show`）与给后续步骤用的同一份推导，避免「读的人自己算一遍」
 * 而算出另一个数（那正是 `n` 有两个产地的开始）。
 *
 * @param {object} input
 * @param {object[]} input.builds - `allBuilds(ledger)` 的产物。
 * @param {object} input.ledger - 台账内容。
 * @param {string} input.target - 目标名。
 * @param {string|null} [input.w] - 计划里的人读标签。
 * @returns {{target: string, upstreamDsh: string|null, n: number|null, desktopVersion: string|null,
 *   error: string|null}} 解出的结果；无法解出时 `error` 有值而其余为 `null`。
 */
export function resolvePlanLine({ builds, ledger, target, w = null }) {
  const inService = inServiceUpstreamKeys(ledger?.releases, target);
  if (inService.length !== 1) {
    return {
      target,
      upstreamDsh: inService[0] ?? null,
      n: null,
      desktopVersion: null,
      error: `在役上游键有 ${inService.length} 条（需要恰好 1 条）`,
    };
  }
  const upstreamDsh = inService[0];
  const n = nextSequenceFor(builds, upstreamDsh);
  try {
    return { target, upstreamDsh, n, desktopVersion: composeDesktopVersion(upstreamDsh, n, w), error: null };
  } catch (error) {
    return { target, upstreamDsh, n, desktopVersion: null, error: error.message };
  }
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
  const ledgerOf = (releases, bridges = []) => ({ schemaVersion: 2, releases, bridges });
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

  // === releaseChannelOf：桌面号 → 通道（豁免判据的前置输入）==================
  // 🔴 闭环夹具：`版本号 → 目标 → 通道` 与 `目标 → 通道` 必须给出同一个答案。
  //    只断言左半边会漏掉「后缀表被改了、通道表没改」这一类漂移。
  eq('通道：合成号 alpha.1.3 → alpha', releaseChannelOf('0.2.1-alpha.1.3'), 'alpha');
  eq('通道：合成号 rc.3.1 → rc（next 目标的 publishChannel 是 rc，不是 next）', releaseChannelOf('0.2.0-rc.3.1'), 'rc');
  eq('通道：带前导 v 与 +w', releaseChannelOf('v0.2.0-rc.3.1+w2'), 'rc');
  eq('通道：桥接号 0.7.3-rc.1 → rc', releaseChannelOf('0.7.3-rc.1'), 'rc');
  // 正式版落**默认目标**（targetForVersion 的既有语义）⇒ 默认目标的 publishChannel。
  // 这与构建期真正选端点的判据同源；换成 desktopChannelForVersion 会得到 'stable'，
  // 那是另一个问题的答案（见函数文档的 boxed 说明）。
  eq('通道：正式版落默认目标（= 端点实际会走的通道）', releaseChannelOf('0.2.1'), 'rc');
  eq('通道：未知后缀（beta）不猜', releaseChannelOf('0.7.0-beta.1'), null);
  eq(
    '通道：与 deriveReleaseChannel 对同一事实给同一答案（两条入口不许各说各话）',
    [releaseChannelOf('0.2.1-alpha.1.3'), deriveReleaseChannel('alpha'), releaseChannelOf('0.2.0-rc.2.1'), deriveReleaseChannel('next')],
    ['alpha', 'alpha', 'rc', 'rc'],
  );
  throws('通道：形状非法必须抛错（ADR-061 守卫 3，不静默回落）', () => releaseChannelOf('0.2.1.3-rc.1'));
  throws('通道：非版本串必须抛错', () => releaseChannelOf('not-a-version'));

  // === ADR-063：桥接版 bridges[] ============================================
  const bridgeRc = {
    version: '0.7.3-rc.1',
    tag: 'v0.7.3-rc.1',
    channel: 'rc',
    target: 'next',
    upstreamDsh: '0.2.0-rc.2',
    relaxes: 'allowDowngrades',
    date: '2026-10-09',
    why: '夹具：rc 通道的换代桥接版',
  };
  const bridgeAlpha = { ...bridgeRc, version: '0.7.4-alpha.1', tag: 'v0.7.4-alpha.1', channel: 'alpha', target: 'alpha', upstreamDsh: '0.2.1-alpha.1' };

  // 「真合成号」判据的**对照物**：这两个键就是本仓在役的两个上游键（见 `--show`）。
  // ⚠️ 它必须与 `fullLedgerOf()` 的键集**一致**，否则夹具会自相矛盾：
  //    同一条记录在单测里判绿、在整体校验里判红（两边用的「什么算台账键」不是同一个事实）。
  const RELEASES = { '0.2.0-rc.2': {}, '0.2.1-alpha.1': {} };

  eq('桥接：合法记录零 problem', validateBridge(bridgeRc, 0, TARGETS, RELEASES), []);
  eq('桥接：alpha 通道同样合法', validateBridge(bridgeAlpha, 1, TARGETS, RELEASES), []);
  eq(
    '桥接：tag 与 version 不符必须报红',
    validateBridge({ ...bridgeRc, tag: 'v0.7.4-rc.1' }, 0, TARGETS, RELEASES).some((p) => p.includes('tag')),
    true,
  );
  // 🔴 核心反例：桥接版**不得**登记成合成号——它存在的意义正是「合成号比它低」。
  eq(
    '桥接：**真合成号**必须报红（合成号不许当桥接版）',
    validateBridge({ ...bridgeRc, version: '0.2.0-rc.2.1', tag: 'v0.2.0-rc.2.1' }, 0, TARGETS, RELEASES).some((p) =>
      p.includes('真合成号'),
    ),
    true,
  );
  // 🔴 可伪证夹具：这是「形状推断」不可靠的**第三次**现形，也是本判据改用台账键的**唯一理由**。
  //    `0.7.3-rc.1` 与真合成号 `0.2.0-rc.2.1` **形状同构**（`splitRepoSequence` 对两者都 ok），
  //    但它的基址 `0.7.3-rc` **不是**台账键 ⇒ 它是旧模型的桥接号 ⇒ 必须放行。
  //    ⇒ 若把判据改回形状，「合法桥接版」会全部假红（改回去这行就会挂）。
  eq(
    '桥接：形状同构但基址不是台账键 ⇒ 放行（故判据只能是台账键，不能是形状）',
    validateBridge(bridgeRc, 0, TARGETS, RELEASES),
    [],
  );
  eq(
    '桥接：形状同构的**实证**（两者都通过 splitRepoSequence，形状无法区分）',
    [splitRepoSequence('0.7.3-rc.1').ok, splitRepoSequence('0.2.0-rc.2.1').ok],
    [true, true],
  );
  eq(
    '桥接：**漏传 releases** 会让「真合成号」判据退化成空集（故调用点必须传第 4 参）',
    validateBridge({ ...bridgeRc, version: '0.2.0-rc.2.1', tag: 'v0.2.0-rc.2.1' }, 0, TARGETS).some((p) =>
      p.includes('真合成号'),
    ),
    false,
  );
  eq(
    '桥接：channel 与 target 现算的 publishChannel 不符必须报红',
    validateBridge({ ...bridgeRc, channel: 'alpha' }, 0, TARGETS, RELEASES).some((p) => p.includes('publishChannel')),
    true,
  );
  eq(
    '桥接：未知 target 必须报红',
    validateBridge({ ...bridgeRc, target: 'beta' }, 0, TARGETS, RELEASES).some((p) => p.includes('目标总表')),
    true,
  );
  eq(
    '桥接：未知放宽手段必须报红（换机制须同批改消费点）',
    validateBridge({ ...bridgeRc, relaxes: 'versionComparator' }, 0, TARGETS, RELEASES).some((p) => p.includes('放宽手段只有')),
    true,
  );
  eq(
    '桥接：缺字段必须报红',
    validateBridge({ ...bridgeRc, upstreamDsh: '' }, 0, TARGETS, RELEASES).some((p) => p.includes('缺字段 upstreamDsh')),
    true,
  );
  eq(
    '桥接：date 形状必须校验',
    validateBridge({ ...bridgeRc, date: '2026/10/09' }, 0, TARGETS, RELEASES).some((p) => p.includes('YYYY-MM-DD')),
    true,
  );
  eq(
    '桥接：version 后缀推出的通道与 channel 不符必须报红',
    validateBridge({ ...bridgeRc, version: '0.7.3-alpha.1', tag: 'v0.7.3-alpha.1' }, 0, TARGETS, RELEASES).some((p) => p.includes('后缀')),
    true,
  );

  // 豁免判据：同通道 + bridge.version ≥ 阈值 + **该 tag 已发布**，三条**都**必须成立。
  // `PUB = ['v0.7.3-rc.1']` 是「桥接版真的送达过」的语料。
  const PUB = ['v0.7.3-rc.1'];
  eq(
    '豁免：同通道且 ≥ 阈值且已发布 ⇒ 命中',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.2-rc.1', tags: PUB })?.version,
    '0.7.3-rc.1',
  );
  eq(
    '豁免：**别的通道**的桥接版不得命中（各通道有自己的端点）',
    findPermittingBridge({ bridges: [bridgeAlpha], channel: 'rc', atLeast: '0.7.2-rc.1', tags: PUB }),
    null,
  );
  eq(
    '豁免：桥接版**低于**阈值 ⇒ 不命中（它当年根本没送达）',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.4-rc.1', tags: PUB }),
    null,
  );
  eq('豁免：空桥接列表 ⇒ null', findPermittingBridge({ bridges: [], channel: 'rc', atLeast: '0.7.2-rc.1', tags: PUB }), null);
  eq(
    '豁免：阈值相等也命中（端点 version == 最新 tag 是合法状态）',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.3-rc.1', tags: PUB })?.version,
    '0.7.3-rc.1',
  );
  eq(
    '豁免：多条命中时取最高的一条',
    findPermittingBridge({
      bridges: [bridgeRc, { ...bridgeRc, version: '0.7.9-rc.1', tag: 'v0.7.9-rc.1' }],
      channel: 'rc',
      atLeast: '0.7.2-rc.1',
      tags: ['v0.7.3-rc.1', 'v0.7.9-rc.1'],
    })?.version,
    '0.7.9-rc.1',
  );
  eq(
    '豁免：脏记录不炸整趟判定（它由 validateBridge 单独判红）',
    findPermittingBridge({ bridges: [{ channel: 'rc', version: '不是一个版本' }, bridgeRc], channel: 'rc', atLeast: '0.7.2-rc.1', tags: PUB })?.version,
    '0.7.3-rc.1',
  );
  // 🔴 可伪证夹具：「登记了」不等于「送达了」。这是本判据最容易写漏的一条——
  //    少了它，一条拖延未发的记录就能永久给出豁免（豁免在跑、客户端其实收不到）。
  eq(
    '豁免：台账登记了但该 tag **未发布** ⇒ 不命中（登记只是意图）',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.2-rc.1', tags: ['v0.7.2-rc.1'] }),
    null,
  );
  eq(
    '豁免：**不给 tags** ⇒ 一律不命中（无凭据不等于默认成立）',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.2-rc.1' }),
    null,
  );
  eq(
    '豁免：空 tags ⇒ 一律不命中',
    findPermittingBridge({ bridges: [bridgeRc], channel: 'rc', atLeast: '0.7.2-rc.1', tags: [] }),
    null,
  );
  // 🔴 可伪证夹具：「最高一条」必须在**已送达**的里面取。若按登记取最高，
  //    一条永不发布的高号会永久压过真正生效的那条（豁免判据据此「命中」却是空依据）。
  eq(
    '豁免：登记最高但未发布时，回落到真正送达的那条',
    findPermittingBridge({
      bridges: [bridgeRc, { ...bridgeRc, version: '0.7.9-rc.1', tag: 'v0.7.9-rc.1' }],
      channel: 'rc',
      atLeast: '0.7.2-rc.1',
      tags: ['v0.7.3-rc.1'],
    })?.version,
    '0.7.3-rc.1',
  );

  // === newestPublishedForChannel：通道 → 该通道最高已发布版本 ==================
  // 语料刻意混入真实脏元素：滚动 tag、历史命名、空串、四段式。
  const TAG_CORPUS = [
    'v0.7.0-alpha.7',
    'v0.7.0-alpha.8',
    'v0.7.0-rc.1',
    'v0.7.1-rc.1',
    'v0.7.3-rc.1',
    'v0.7.3-alpha.1',
    'v0.7.4-alpha.1',
    'updater-rc',
    'vNext',
    'batch-2026',
    '',
    'v0.7.0.1-rc.1',
  ];
  eq('通道最高：rc 线', newestPublishedForChannel(TAG_CORPUS, 'rc'), '0.7.3-rc.1');
  eq('通道最高：alpha 线', newestPublishedForChannel(TAG_CORPUS, 'alpha'), '0.7.4-alpha.1');
  // 🔴 可伪证夹具：全局最高是 alpha 的号，rc 的基准**不得**被它抬高——否则 rc 的合格
  //    桥接版（0.7.3-rc.1）永远压不过 0.7.4-alpha.1，豁免变成永不生效的装饰。
  eq(
    '通道最高：不取全局最高（alpha 的最高号不得压在 rc 上）',
    newestPublishedForChannel(TAG_CORPUS, 'rc') !== newestPublishedForChannel(TAG_CORPUS, 'alpha'),
    true,
  );
  eq('通道最高：脏 tag 不炸整趟扫描', newestPublishedForChannel(['vNext', 'batch-2026', '', 'v0.7.0-rc.1'], 'rc'), '0.7.0-rc.1');
  eq('通道最高：四段式脏 tag 被跳过', newestPublishedForChannel(['v0.7.0.1-rc.1', 'v0.7.0-rc.1'], 'rc'), '0.7.0-rc.1');
  eq('通道最高：本通道无 tag → null', newestPublishedForChannel(['v0.7.0-alpha.8'], 'rc'), null);
  eq('通道最高：空语料 → null', newestPublishedForChannel([], 'rc'), null);
  eq('通道最高：通道名为空 → null', newestPublishedForChannel(TAG_CORPUS, '  '), null);
  // 🔴 两分法（对称失效守卫）：**同一串、两种意图、相反结果**，期望值硬编码。
  eq('两分法：脏串在扫描里只是被跳过', newestPublishedForChannel(['v0.7.0.1-rc.1'], 'rc'), null);
  throws('两分法：同一串作「已知版本号」必须抛错', () => releaseChannelOf('0.7.0.1-rc.1'));

  // === bridgeExemptionFor：豁免判定的**唯一产地** ==============================
  // 夹具 = 本轮的目标状态：两条桥接版都**已发布**（语料里含它们各自的 tag），各通道各自有最高 tag。
  const liveTags = ['v0.7.3-rc.1', 'v0.7.4-alpha.1'];
  const twoBridges = [bridgeRc, bridgeAlpha];
  const rcExempt = bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: liveTags, bridges: twoBridges });
  eq('豁免判定：rc 合成号被本通道桥接版豁免', rcExempt.granted, true);
  eq('豁免判定：通道取 rc', rcExempt.channel, 'rc');
  eq('豁免判定：比较基准是**本通道**最高 tag', rcExempt.atLeast, '0.7.3-rc.1');
  eq('豁免判定：命中记录就是那条桥接版', rcExempt.bridge?.version, '0.7.3-rc.1');
  eq('豁免判定：理由为 bridge', rcExempt.reason, 'bridge');
  // 🔴 不变式（豁免成立时必然成立，值得显式钉住）：桥接版就是该通道**最新发出去的号**。
  //    推导：已被发布 ⇒ ≤ 该通道最高 tag；又要 ≥ 该通道最高 tag ⇒ 相等。
  //    它一旦不成立，说明「豁免覆盖了一个比它更高的号」——那种客户端不会接受本版。
  eq(
    '豁免判定：豁免成立时桥接版 == 该通道最高已发布版本（不变式）',
    rcExempt.bridge?.version === rcExempt.atLeast,
    true,
  );
  const alphaExempt = bridgeExemptionFor({ version: '0.2.1-alpha.1.1', tags: liveTags, bridges: twoBridges });
  eq('豁免判定：alpha 合成号同样被本通道桥接版豁免', [alphaExempt.granted, alphaExempt.atLeast], [true, '0.7.4-alpha.1']);
  // 🔴 可伪证夹具：**桥接版还没登记**时必须不豁免——这正是「先发 bridge 再发合成号」
  //    的强制机制。若这条变绿，「先发 bridge」就只是文档里的一句倡议。
  eq(
    '豁免判定：桥接版未登记 ⇒ 不豁免（合成号必须先等 bridge 上线）',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: liveTags, bridges: [] }).granted,
    false,
  );
  eq(
    '豁免判定：不豁免的理由点名「本通道无合格桥接版」',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: liveTags, bridges: [] }).reason,
    'no-bridge-on-channel',
  );
  // 🔴 可伪证夹具：**别的通道**的桥接版不得豁免本通道（各通道有自己的端点）。
  eq(
    '豁免判定：只有 alpha 桥接版时 rc 合成号不获豁免',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: liveTags, bridges: [bridgeAlpha] }).granted,
    false,
  );
  // 🔴 可伪证夹具：桥接版**低于**本通道最高 tag ⇒ 它当年根本没送达 ⇒ 无凭据。
  eq(
    '豁免判定：桥接版低于本通道最高 tag ⇒ 不豁免',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: ['v0.8.0-rc.1'], bridges: twoBridges }).granted,
    false,
  );
  eq(
    '豁免判定：本通道无已发布 tag ⇒ 不豁免（豁免无凭据）',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: ['v0.7.4-alpha.1'], bridges: twoBridges }).reason,
    'no-tags-on-channel',
  );
  // 🔴 可伪证夹具：「台账已改、tag 没打」是最该被拦下的形态（发了一半）。
  //    它必须与「压根没登记」分开报，因为下一步动作不同（前者要补发 tag，后者要先发桥接版）。
  {
    const halfWay = bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: ['v0.7.2-rc.1'], bridges: twoBridges });
    eq('豁免判定：桥接版已登记但**未发布 tag** ⇒ 不豁免', halfWay.granted, false);
    eq('豁免判定：理由点名「未送达」，不与「压根没登记」混为一谈', halfWay.reason, 'bridge-not-delivered');
  }
  eq(
    '豁免判定：压根没登记时的理由确实是「无合格桥接版」（与上一条相反）',
    bridgeExemptionFor({ version: '0.2.0-rc.2.1', tags: ['v0.7.2-rc.1'], bridges: [] }).reason,
    'no-bridge-on-channel',
  );
  eq(
    '豁免判定：通道不可判定（未知后缀）⇒ 不豁免',
    bridgeExemptionFor({ version: '0.7.0-beta.1', tags: liveTags, bridges: twoBridges }).reason,
    'unresolved-channel',
  );
  // 长期性：合成号发出去之后，本通道最高 tag **仍是**桥接版（合成号更低）⇒ 后续合成号继续获豁免。
  // 这就是「豁免无需逐次补登记」的机制依据；若哪天它不成立了，这条会立刻变红。
  eq(
    '豁免判定：首个合成号发布后豁免仍在（本通道最高 tag 仍是桥接版）',
    bridgeExemptionFor({ version: '0.2.0-rc.2.2', tags: [...liveTags, 'v0.2.0-rc.2.1'], bridges: twoBridges }).granted,
    true,
  );
  eq(
    '豁免判定：上一条的基准确实还是桥接版（不是新发的合成号）',
    bridgeExemptionFor({ version: '0.2.0-rc.2.2', tags: [...liveTags, 'v0.2.0-rc.2.1'], bridges: twoBridges }).atLeast,
    '0.7.3-rc.1',
  );

  // checkLedger 必须把桥接版层一起查——否则「登记了一条坏记录」只会等到豁免判据失效才现形。
  // ⚠️ 夹具必须**覆盖两个在役目标**（否则索引层会先报「缺 alpha 键」，断言就会因为
  //    **别的原因**变红——那是假绿的一种：判据没坏，用例坏了）。
  const fullLedgerOf = (bridges = []) =>
    ledgerOf(
      {
        '0.2.0-rc.2': { patchTarget: 'next', upstreamDistTag: 'next', status: 'active', builds: [] },
        '0.2.1-alpha.1': { patchTarget: 'alpha', upstreamDistTag: 'alpha', status: 'active', builds: [] },
      },
      bridges,
    );
  eq('整体校验：合法桥接版不产生 problem', checkLedger({ ledger: fullLedgerOf([bridgeRc]), targets: TARGETS }), []);
  eq(
    '整体校验：坏桥接版必须报红（理由点名 publishChannel，不是被索引层顺带带出来的）',
    checkLedger({ ledger: fullLedgerOf([{ ...bridgeRc, channel: 'alpha' }]), targets: TARGETS }).some((p) =>
      p.includes('publishChannel'),
    ),
    true,
  );
  eq(
    '整体校验：同通道同版本登记两次必须报红（豁免「最高一条」不唯一）',
    checkLedger({ ledger: fullLedgerOf([bridgeRc, { ...bridgeRc, date: '2026-10-10' }]), targets: TARGETS }).some((p) =>
      p.includes('同通道同版本'),
    ),
    true,
  );
  eq('整体校验：不同通道可各有一条', checkLedger({ ledger: fullLedgerOf([bridgeRc, bridgeAlpha]), targets: TARGETS }), []);

  // === Release Plan（release-manifest.json）：发布前的唯一决策面 ================
  // 为什么必须有这一层：`releaseType` / `breaking` / `lines` 此前只写在策略文档里，
  // **没有任何代码读它**。一份「策略要求写、流程从不读」的计划文件，与没有这个文件等价，
  // 但看起来像有（ADR-007：无声降级）。
  //
  // 夹具刻意用 `ledger2e`（两线的现算 n **不同**：alpha → 3、next → 8），不用空台账：
  // 空台账下两条线现算的 n 都是 1，「全局取一个 n 再分发」的错误实现会全绿。
  const planOf = (lines, over = {}) => ({
    schemaVersion: PLAN_SCHEMA_VERSION,
    releaseType: 'mixed',
    breaking: false,
    lines,
    ...over,
  });
  const PLAN_LINES = { next: { n: 8, w: null }, alpha: { n: 3, w: 'batch' } };
  const checkPlan = (plan, ledger = ledger2e, targets = TARGETS) => checkReleasePlan({ plan, ledger, targets });

  eq('计划：合法计划零 problem', checkPlan(planOf(PLAN_LINES)), []);
  eq('计划：w 可以是 null（不带人读标签）', checkPlan(planOf({ alpha: { n: 3, w: null } })), []);
  // 只发一条线是**合法**状态：计划答「这一次发哪几条」，不是「必须发满所有在役线」。
  eq('计划：只写一条线也合法（不必把在役线全列上）', checkPlan(planOf({ next: { n: 8, w: null } })), []);
  eq(
    '计划：n 与台账不符必须报红（n 不由人填，ADR-061）',
    checkPlan(planOf({ next: { n: 1, w: null } })).some((p) => p.includes('lines.next')),
    true,
  );
  // 🔴 可伪证夹具：「两行共用同一个 n」是「全局取一个 n 再分发」最可能的现形形态。
  //    next 那行仍会判绿（8 恰好对），只有 alpha 这行能揭穿它。
  eq(
    '计划：两行不得共用同一个 n（各线各有自己的序号）',
    checkPlan(planOf({ next: { n: 8, w: null }, alpha: { n: 8, w: null } })).some((p) => p.includes('lines.alpha')),
    true,
  );
  eq(
    '计划：报错必须给出台账的现算值（读的人要知道该改成几）',
    checkPlan(planOf({ alpha: { n: 8, w: null } })).some((p) => p.includes('现算的下一个序号是 3')),
    true,
  );
  // 🔴 可伪证夹具：`schemaVersion` 必须**有人查**。把它改回「只声明不断言」，这条会红。
  eq(
    '计划：schemaVersion 不符必须报红（只声明不校验 = 长得像守卫）',
    checkPlan({ ...planOf(PLAN_LINES), schemaVersion: 2 }).some((p) => p.includes('schemaVersion')),
    true,
  );
  eq(
    '计划：schemaVersion 缺失同样报红（不得默认放行）',
    checkPlan({ releaseType: 'mixed', breaking: false, lines: PLAN_LINES }).some((p) => p.includes('schemaVersion')),
    true,
  );
  eq(
    '计划：releaseType 必须四选一（§3.2）',
    checkPlan({ ...planOf(PLAN_LINES), releaseType: 'massive' }).some((p) => p.includes('releaseType')),
    true,
  );
  eq(
    '计划：breaking 必须是布尔（字符串 "no" 不算）',
    checkPlan({ ...planOf(PLAN_LINES), breaking: 'no' }).some((p) => p.includes('breaking')),
    true,
  );
  // 空集判据（AGENTS.md §7.3）：没有可派生的对象 ≠ 派生出零个版本是对的。
  eq(
    '计划：lines 为空 ⇒ 判红（空集不得冒充通过）',
    checkPlan(planOf({})).some((p) => p.includes('空')),
    true,
  );
  eq('计划：lines 是数组 ⇒ 判红', checkPlan(planOf([])).some((p) => p.includes('lines 必须是对象')), true);
  eq('计划：整个 plan 是数组 ⇒ 判红', checkPlan([]).some((p) => p.includes('必须是')), true);
  // 派生值（合成号）**不得**出现在计划里——那会让合成号有两个产地。
  eq(
    '计划：行内未知字段必须报红（合成号不在计划里）',
    checkPlan(planOf({ next: { n: 8, w: null, desktopVersion: '0.2.0-rc.2.8' } })).some((p) =>
      p.includes('desktopVersion'),
    ),
    true,
  );
  // 同一纪律的另一半：只给行内做白名单，顶层就留了后门——`breakng` 会安静地不生效，
  // 而**真正生效的默认值**读的人看不见。
  eq(
    '计划：未知顶层字段必须报红（打错字的字段会安静地不生效）',
    checkPlan(planOf(PLAN_LINES, { breakng: true })).some((p) => p.includes('未知顶层字段')),
    true,
  );
  eq(
    '计划：`$comment` 是允许的（换代/桥接这类场合必须能把适用范围写进去）',
    checkPlan(planOf(PLAN_LINES, { $comment: ['说明'] })),
    [],
  );
  eq(
    '计划：不存在的目标名必须报红',
    checkPlan(planOf({ beta: { n: 1, w: null } })).some((p) => p.includes('不在目标总表')),
    true,
  );
  eq(
    '计划：休眠目标不得发布（ADR-056 / ADR-057）',
    checkPlan(planOf({ next: { n: 8, w: null } }), ledger2e, {
      next: { ...TARGETS.next, status: 'dormant' },
    }).some((p) => p.includes('休眠')),
    true,
  );
  eq(
    '计划：目标在台账里的在役上游键不唯一 ⇒ 判红（不知道用哪套补丁）',
    checkPlan(
      planOf({ next: { n: 1, w: null } }),
      ledgerOf({
        '0.2.0-rc.2': { patchTarget: 'next', status: 'active', builds: [] },
        '0.2.0-rc.3': { patchTarget: 'next', status: 'active', builds: [] },
      }),
    ).some((p) => p.includes('恰好一个')),
    true,
  );
  eq(
    '计划：目标在台账里无在役键 ⇒ 判红（0 条也算不唯一）',
    checkPlan(planOf({ next: { n: 1, w: null } }), ledgerOf({ '0.2.1-alpha.1': { patchTarget: 'alpha', status: 'active', builds: [] } })).some(
      (p) => p.includes('恰好一个'),
    ),
    true,
  );
  eq(
    '计划：n 必须是 ≥ 1 的整数（0 也报红）',
    checkPlan(planOf({ next: { n: 0, w: null } })).some((p) => p.includes('≥ 1 的整数')),
    true,
  );
  eq(
    '计划：n 是字符串 "8" 也必须报红（不得靠 == 蒙过去）',
    checkPlan(planOf({ next: { n: '8', w: null } })).some((p) => p.includes('≥ 1 的整数')),
    true,
  );
  // §7.2 不变式：`w` 里不许出现 `_`（它会让资产名与 URL 的解析分叉）。
  eq(
    '计划：w 含下划线必须报红',
    checkPlan(planOf({ next: { n: 8, w: 'a_b' } })).some((p) => p.includes('字符集')),
    true,
  );
  eq(
    '计划：w 是数字也必须报红',
    checkPlan(planOf({ next: { n: 8, w: 1 } })).some((p) => p.includes('字符集')),
    true,
  );
  eq(
    '计划：行本身不是对象 ⇒ 判红（不是静默跳过）',
    checkPlan(planOf({ next: 'n=8' })).some((p) => p.includes('必须是对象')),
    true,
  );

  // --- resolvePlanLine：计划 → 合成号那一份**唯一的**推导 ---------------------
  const builds2e = allBuilds(ledger2e);
  const resolvedAlphaPlan = resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: 'alpha', w: 'batch' });
  eq('解出：目标 → 在役上游键', resolvedAlphaPlan.upstreamDsh, '0.2.1-alpha.1');
  eq('解出：下一个 n 由台账现算（组内 max+1）', resolvedAlphaPlan.n, 3);
  eq('解出：合成号由唯一产地合成', resolvedAlphaPlan.desktopVersion, '0.2.1-alpha.1.3+batch');
  eq('解出：成功时 error 为 null', resolvedAlphaPlan.error, null);
  eq(
    '解出：不传 w ⇒ 无标签（不继承上一条的 w）',
    resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: 'alpha' }).desktopVersion,
    '0.2.1-alpha.1.3',
  );
  eq(
    '解出：next 线走 rc 后缀，n 取本组（不是全局）',
    resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: 'next' }).desktopVersion,
    '0.2.0-rc.2.8',
  );
  // 🔴 可伪证夹具：在役键不唯一时**不得挑第一条**——挑一条 = 悄悄替人做了决策。
  {
    const ambiguous = ledgerOf({
      '0.2.0-rc.2': { patchTarget: 'next', status: 'active', builds: [] },
      '0.2.0-rc.3': { patchTarget: 'next', status: 'active', builds: [] },
    });
    const out = resolvePlanLine({ builds: allBuilds(ambiguous), ledger: ambiguous, target: 'next' });
    eq('解出：在役键不唯一 ⇒ 不给版本号', out.desktopVersion, null);
    eq('解出：在役键不唯一 ⇒ 带出原因（2 条）', out.error.includes('2 条'), true);
  }
  // 🔴 可伪证夹具：合成层抛出的原因必须**带出来**，不得被吞成「没有版本号」。
  //    吞掉之后，`w` 写错会表现为「这一步没产出」，读的人以为是别的原因。
  {
    const bad = resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: 'alpha', w: 'a_b' });
    eq('解出：w 非法 ⇒ 不给版本号', bad.desktopVersion, null);
    eq('解出：w 非法 ⇒ error 有内容（原因不被吞）', typeof bad.error === 'string' && bad.error.length > 0, true);
    eq('解出：w 非法时 n 仍如实给出（便于定位）', bad.n, 3);
  }
  // 🔴 闭环夹具：判绿的计划那一行，解出来的 n 必须**逐字**等于计划里写的 n。
  //    两条判据若各算一遍（一个查台账、一个另算），漂移只在发布当天现形。
  eq(
    '闭环：计划判绿的每一行，解出的 n 与计划里的 n 一致',
    ['next', 'alpha'].map(
      (t) => resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: t, w: PLAN_LINES[t].w }).n,
    ),
    [PLAN_LINES.next.n, PLAN_LINES.alpha.n],
  );
  eq(
    '闭环：解出的合成号确实是台账的下一号（与 planNextDesktopVersion 同源）',
    resolvePlanLine({ builds: builds2e, ledger: ledger2e, target: 'alpha' }).desktopVersion,
    planNextDesktopVersion({ builds: builds2e, upstreamDsh: '0.2.1-alpha.1' }).desktopVersion,
  );

  // readReleasePlan：**缺失必须抛错**，不得返回空计划——「计划为空」与「计划没读进来」
  // 长得一模一样，而后者会让第 4 步派生出一个**没人决策过**的版本号。
  // 本断言只走「文件不存在」这一支：路径指向一个必然不存在的目录，不读任何内容。
  throws('读取：release-manifest.json 缺失必须抛错', () =>
    readReleasePlan(join(process.cwd(), 'no-such-dir-for-plan-fixture')),
  );

  // --- 恒时组 vs 时点组：**同一份输入、两种意图、相反结论** -------------------
  // 这是「判据该去哪一级」的可执行形态。`ledger2e` 的 alpha 组已交付 n=1、2 ⇒ 下一个是 3。
  // 计划写 n=2 ⇒ 它是**刚发出去的那一次**：作为历史快照合法（恒时组必须绿），
  // 作为「这一次要发几」非法（时点组必须红）。
  // 🔴 若有人把 `--validate` 改成跑时点判据，门禁会在每次发布后变红，直到有人乱改 n——
  //    这条夹具同时把那种改法的后果钉在这里。
  const stalePlan = planOf({ alpha: { n: 2, w: null } });
  eq(
    '两分法：已交付的 n 在**恒时组**合法（它就是刚发出去那一次的快照）',
    checkReleasePlanStructure({ plan: stalePlan, ledger: ledger2e, targets: TARGETS }),
    [],
  );
  eq(
    '两分法：同一个 n 在**时点组**必须判红（决策时刻不许拿历史值派生版本号）',
    checkReleasePlan({ plan: stalePlan, ledger: ledger2e, targets: TARGETS }).length > 0,
    true,
  );
  eq(
    '两分法：报错要指明「已发过就说明这是历史快照」',
    checkReleasePlan({ plan: stalePlan, ledger: ledger2e, targets: TARGETS }).some((p) =>
      p.includes('已经发过'),
    ),
    true,
  );
  // 恒时组照样给出「这条计划现在是当前值还是历史值」——**事实**，不是判据。
  // 少了它，读的人只能看到「计划里写着 n=1」，看不出那是下一个还是上一个。
  eq(
    '两分法：恒时组也给出 current=true（当前值）',
    diagnoseReleasePlan({ plan: planOf({ alpha: { n: 3, w: null } }), ledger: ledger2e, targets: TARGETS }).notes[0]
      .current,
    true,
  );
  eq(
    '两分法：恒时组也给出 current=false（历史值）',
    diagnoseReleasePlan({ plan: stalePlan, ledger: ledger2e, targets: TARGETS }).notes[0].current,
    false,
  );
  eq(
    '两分法：notes 带出两边的 n（读的人不必自己再推一遍）',
    diagnoseReleasePlan({ plan: stalePlan, ledger: ledger2e, targets: TARGETS }).notes[0].nextN,
    3,
  );
  // 恒时组**不**因为「计划缺一条线」而红——那是「这一次发哪几条」的决策，门禁无权替人裁决。
  eq(
    '两分法：恒时组不要求两条线都在（发几条线是人的决策）',
    checkReleasePlanStructure({ plan: planOf({ next: { n: 8, w: null } }), ledger: ledger2e, targets: TARGETS }),
    [],
  );

  // --- checkPlanLineFor：第 3→4 步的强制点（前门用） --------------------------
  const planLines = planOf(PLAN_LINES);
  eq(
    '前门：批准过的线 + n 是台账下一个 + w 一致 ⇒ 零 problem',
    checkPlanLineFor({ plan: planLines, ledger: ledger2e, target: 'next', w: null, targets: TARGETS }),
    [],
  );
  eq(
    '前门：带 w 的行同样比对 w',
    checkPlanLineFor({ plan: planLines, ledger: ledger2e, target: 'alpha', w: 'batch', targets: TARGETS }),
    [],
  );
  // 🔴 可伪证夹具：**计划没批准这条线**时必须拦住——否则「先出计划」只是文档里的一句话。
  eq(
    '前门：计划里没有这条线 ⇒ 判红（没批准就不许派生）',
    checkPlanLineFor({
      plan: planOf({ next: { n: 8, w: null } }),
      ledger: ledger2e,
      target: 'alpha',
      targets: TARGETS,
    }).some((p) => p.includes('没有') && p.includes('alpha')),
    true,
  );
  // 🔴 可伪证夹具：`w` 进版本号（`+w`）⇒ 计划与实际不一致时发出去的串与批准的不是同一个。
  eq(
    '前门：w 与计划不符 ⇒ 判红（w 进版本号，不是纯注释）',
    checkPlanLineFor({ plan: planLines, ledger: ledger2e, target: 'alpha', w: null, targets: TARGETS }).some((p) =>
      p.includes('w'),
    ),
    true,
  );
  eq(
    '前门：n 与台账不符 ⇒ 判红（时点判据照样跑）',
    checkPlanLineFor({
      plan: planOf({ alpha: { n: 2, w: null } }),
      ledger: ledger2e,
      target: 'alpha',
      targets: TARGETS,
    }).some((p) => p.includes('现算的下一个序号')),
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

  --show                  显示台账与各上游组的下一个 n（含桥接版 bridges[]、Release Plan）
  --validate [--version v] 校验台账内部一致性 + Release Plan 的**恒时**判据；
                          给了 --version 则连带断言该版本已在台账里
  --validate --strict-plan 额外跑 Release Plan 的**时点**判据（n == 台账现算值）
  --add-bridge <版本> [--apply]  登记桥接版（默认只读；--apply 才写）
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
    // ---- Release Plan（第 3 步的人工决策面）----
    // ⚠️ 这里**默认只跑恒时判据**（结构 / 目标 / 在役键唯一 / 字段白名单 / w 字符集）。
    //    「n == 台账现算的下一个」是**时点**判据：计划发出去之后它必然不成立，
    //    放进每次 PR 都跑的门禁 ⇒ 每个与发布无关的 PR 都要顺手改一个 n，然后有人把判据删掉。
    //    时点判据的去处是决策前门（sync-upstream-release）与 `--strict-plan`。
    //    完整理由见 `diagnoseReleasePlan()` 的 boxed 段。
    const withSequence = args.includes('--strict-plan');
    let planNotes = null;
    let planMeta = null;
    try {
      const plan = readReleasePlan();
      const diagnosed = diagnoseReleasePlan({ plan, ledger, targets: DSH_TARGETS, withSequence });
      problems.push(...diagnosed.problems);
      planNotes = diagnosed.notes;
      planMeta = { releaseType: plan.releaseType, breaking: plan.breaking };
    } catch (error) {
      // 文件缺失 / JSON 坏了 / 不是对象 —— 三种都**不得**当成「没有计划」放过去。
      // 「计划为空」与「计划没读进来」长得一模一样，而后者会让第 4 步派生出没人决策过的版本号。
      problems.push(`${PLAN_RELATIVE}：读不到或不可用 —— ${error.message}`);
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
    // 计划的状态**按事实打印**（不是判据）：读的人要能一眼看出「计划里这个 n 是下一个还是上一个」。
    if (planNotes !== null) {
      console.log(
        `   Release Plan：releaseType=${planMeta.releaseType} breaking=${planMeta.breaking}` +
          `${withSequence ? '（已跑时点判据）' : '（恒时判据）'}`,
      );
      for (const note of planNotes) {
        const state =
          note.current === null
            ? 'n 不合法，未判定'
            : note.current
              ? `= 台账现算的下一个（当前）`
              : `是**历史值**：台账现算的下一个是 ${note.nextN}（本计划描述的是已交付的那一次）`;
        console.log(`     lines.${note.target}：n=${note.plannedN} w=${note.w ?? 'null'} → ${state}`);
      }
      if (!withSequence && planNotes.some((n) => n.current === false)) {
        console.warn(
          `⚠️  上面标记为「历史值」的行说明本计划描述的是**已交付**的那一次，不是下一次。` +
            `要发下一版，先按第 3 步改计划（时点判据只在 sync-upstream-release / --strict-plan 跑）。`,
        );
      }
    }
    console.log(
      `✅ 台账自洽（${Object.keys(ledger.releases).length} 个上游键，${builds.length} 条构建记录，` +
        `${(ledger.bridges ?? []).length} 条桥接版记录，${planNotes?.length ?? 0} 条计划行）`,
    );
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
    const bridges = ledger.bridges ?? [];
    console.log(`  桥接版（bridges[]，${bridges.length} 条）：`);
    if (bridges.length === 0) {
      console.log('    （无——旧模型的高号仍在线上，合成号会比它们低）');
    }
    for (const bridge of bridges) {
      console.log(
        `    ${String(bridge.version).padEnd(16)} channel=${String(bridge.channel).padEnd(6)} ` +
          `target=${String(bridge.target).padEnd(6)} relaxes=${bridge.relaxes} 上游=${bridge.upstreamDsh}  ${bridge.date}`,
      );
    }
    // Release Plan（第 3 步的决策面）：每行解出「按台账现算会派生出什么」。
    // ⚠️ 缺文件时**如实说**，不静默当成「没有计划」——否则 `--show` 会看起来一切正常。
    console.log(`  Release Plan（${PLAN_RELATIVE}）：`);
    let plan = null;
    try {
      plan = readReleasePlan();
    } catch (error) {
      console.log(`    ⚠️ 读不到：${error.message}`);
    }
    if (plan !== null) {
      console.log(
        `    releaseType=${String(plan.releaseType)} breaking=${String(plan.breaking)} schemaVersion=${String(plan.schemaVersion)}`,
      );
      const builds = allBuilds(ledger);
      for (const [name, line] of Object.entries(plan.lines ?? {})) {
        const resolved = resolvePlanLine({ builds, ledger, target: name, w: line?.w ?? null });
        const derived =
          resolved.desktopVersion === null ? `解不出：${resolved.error}` : `按台账现算会派生出 ${resolved.desktopVersion}`;
        const state = resolved.n === null ? '' : resolved.n === line?.n ? '（计划是当前值）' : `（计划 n=${line?.n} 是历史值）`;
        console.log(`    ${name.padEnd(8)} 计划 n=${line?.n} w=${line?.w ?? 'null'} ⇒ ${derived}${state}`);
      }
    }
    return 0;
  }
  if (args.includes('--add-bridge')) {
    const at = args.indexOf('--add-bridge');
    const version = args[at + 1];
    if (!version || version.startsWith('--')) {
      console.error('用法：release-ledger.mjs --add-bridge <版本> [--apply]');
      return 2;
    }
    const apply = args.includes('--apply');
    let target;
    try {
      target = targetForVersion(version);
    } catch (error) {
      console.error(`❌ 无法从版本号推出目标：${error.message}`);
      return 1;
    }
    if (target === null) {
      console.error(
        `❌ ${version} 的预发布后缀不对应任何目标的 publishChannel ⇒ 不知道该由哪条通道的端点投递它。` +
          `可用后缀：${Object.entries(DSH_TARGETS).map(([n, t]) => `${n}=${t.publishChannel}`).join(' / ')}`,
      );
      return 1;
    }
    const inService = inServiceUpstreamKeys(ledger.releases, target);
    if (inService.length !== 1) {
      console.error(
        `❌ 目标 ${target} 的在役上游键有 ${inService.length} 条（${inService.join(', ') || '无'}）——` +
          `桥接版必须绑定**恰好一个**上游精确版本，否则「它内置的是哪套运行时」没有唯一定论。`,
      );
      return 1;
    }
    const record = {
      version,
      tag: `v${version}`,
      channel: deriveReleaseChannel(target),
      target,
      upstreamDsh: inService[0],
      relaxes: 'allowDowngrades',
      date: args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10),
      why:
        `合成号（ADR-061）跟随上游 ${inService[0]}，排序上低于旧模型的 0.7.x ⇒ 已安装客户端按默认判据` +
        `（release > current）收不到它。本版内置 allowDowngrades（比较器放宽为「必须不同」）作为换代桥接。`,
    };
    const problems = validateBridge(record, (ledger.bridges ?? []).length, DSH_TARGETS, ledger.releases);
    const already = (ledger.bridges ?? []).some(
      (b) => b?.channel === record.channel && b?.version === record.version,
    );
    if (already) problems.push(`${LEDGER_RELATIVE} 里已有 ${record.channel} 通道的桥接版 ${version}`);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`❌ ${problem}`);
      return 1;
    }
    console.log(`📋 桥接版记录（--plan，未落盘）：`);
    console.log(`   ${JSON.stringify(record, null, 2).split('\n').join('\n   ')}`);
    if (!apply) {
      console.log(`\n   加 --apply 才写入 ${LEDGER_RELATIVE}。`);
      return 0;
    }
    const next = { ...ledger, bridges: [...(ledger.bridges ?? []), record] };
    writeFileSync(ledgerPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`✅ 已写入 ${LEDGER_RELATIVE}：bridges[] 追加 1 条（${record.channel} / ${version}）`);
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
