#!/usr/bin/env node
/**
 * verify-version.mjs — 版本策略的三条守卫（`docs/version-policy.md` §7.1）。
 *
 * ## 它守什么
 *
 * | # | 断言 | 反例（必须判红） |
 * |---|---|---|
 * | 1 | 已发布构建不得共享 `(上游, n)`；且 `n` 序列无空洞 | 台账里出现两条 `(0.2.1-alpha.1, 3)`，或有 `n=2` 却没有 `n=1` |
 * | 2 | `w`（build 段）**永不参与排序** | `compareSemver('…+w1','…+w2')` 不再等于 `0` |
 * | 3 | 通道解析**不得静默回落** | `targetForVersion('0.2.1.3-rc.1')` 不再抛错而返回 `next` |
 *
 * ## 为什么这三条要合成一个守卫
 *
 * 它们各自是「矩阵型」缺陷——**每一处单独看都合理，合起来才致命**：
 * 守卫 1 错了会在台账里留下重复序号（updater 视为同一版，一份更新永远推不出去）；
 * 守卫 2 错了会让排序**静默**改行为（SemVer 规范说 build 无优先级，本仓 JS 实现
 * 也确实忽略它——`tauri-plugin-updater` 用的 Rust `Ord` **却包含** build。
 * 两套实现今天不一致，而排序键刻意不落在 build 上，正是为了**不依赖**这个巧合）；
 * 守卫 3 错了会按**错的**补丁集与 lockfile 组装而**不报错**。
 *
 * ## 反空判据（为什么 `--self-test` 里会注入「坏实现」）
 *
 * 「守卫全绿」可能有两种含义：真的没问题，或**判据本身坏了**。因此本脚本的每条守卫
 * 都把「被探测的实现」**参数化**（如比较器、解析器），自测里注入一个已知有缺陷的实现，
 * 断言守卫**会**报红。这比「跑一遍真的、看到绿」强得多——后者在判据写错时同样给绿。
 *
 * ## CLI
 *
 * ```
 * node scripts/verify-version.mjs             真检查（读台账 + 探测三处实现）
 * node scripts/verify-version.mjs --self-test 纯逻辑自测（含注入式可伪证夹具）
 * ```
 */
import { argv, exit } from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareSemver } from './conventional-commits.mjs';
import { channelOfPrerelease, DSH_TARGETS, parseVersionShape, targetForVersion } from './dsh-targets.mjs';
import { allBuilds, checkLedger, readLedger, splitRepoSequence } from './release-ledger.mjs';

/**
 * **守卫 1**：台账内部一致性（索引覆盖 / 重复二元组 / `n` 序列空洞 / 记录与版本号逐字自洽）。
 *
 * 委托给台账模块，保证「判据只写一次」——守卫脚本与 `release-ledger --validate`
 * 不会各自漂移出一套规则。
 *
 * ⚠️ 参数是**台账整体**（按键索引）而不是一堆记录：索引层那条判据（「每个在役目标的锚点
 * 都必须在台账里有键」）只能在整体上判，而它恰恰是「`builds[]` 全空时这条守卫还在不在查」
 * 的唯一判据。若把参数降级成 `builds[]`，空台账就会让整条守卫**空转**且看不出来。
 *
 * @param {{releases: Record<string, object>}} ledger - 台账内容。
 * @param {Record<string, object>} [targets] - 目标总表；默认 {@link DSH_TARGETS}。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkLedgerInvariants(ledger, targets = DSH_TARGETS) {
  const problems = checkLedger({ ledger, targets });
  // 补一条 §7.2 的不变式：x.y.z 必须逐位等于上游（core 段不得被本仓改写）。
  // 上游身份取自**索引键**（由 allBuilds 附着），不取自记录字段。
  for (const build of allBuilds(ledger)) {
    const split = splitRepoSequence(build.desktopVersion);
    const upstream = parseVersionShape(build.upstreamDsh);
    if (!split.ok || !upstream.ok) continue;
    const core = `${upstream.major}.${upstream.minor}.${upstream.patch}`;
    if (!split.base.startsWith(core)) {
      problems.push(
        `台账记录 ${build.upstreamDsh} n=${build.n}：desktopVersion ${build.desktopVersion} 的核心段` +
          `不等于上游 ${build.upstreamDsh} 的 ${core}——本仓**不得占 patch 段**（§1.1 硬约束 1）。`,
      );
    }
  }
  return problems;
}

/**
 * **守卫 2**：`w` 永不参与排序。
 *
 * 被探测的比较器**参数化**注入，便于自测证明判据非空。
 *
 * @param {(a: string, b: string) => number} [compare] - 比较器；默认本仓实现。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkBuildMetadataNotOrdered(compare = compareSemver) {
  const problems = [];
  const cases = [
    ['0.2.1-alpha.1.3+w1', '0.2.1-alpha.1.3+w2', '同一版本的两个 w 标签'],
    ['0.2.1-alpha.1.3', '0.2.1-alpha.1.3+w1', '有 w 与无 w'],
    ['0.7.0-rc.1+w9', '0.7.0-rc.1+w10', 'w 的字典序陷阱（w9 > w10）'],
  ];
  for (const [a, b, label] of cases) {
    let got;
    try {
      got = compare(a, b);
    } catch (error) {
      problems.push(`守卫 2：比较 ${a} 与 ${b}（${label}）时抛错：${error.message}`);
      continue;
    }
    if (got !== 0) {
      problems.push(
        `守卫 2：${a} vs ${b}（${label}）应判**相等**（build 段无优先级），实得 ${got}。` +
          `排序键刻意只落在预发布段，就是为了不依赖「某个实现恰好比较 build」这个巧合。`,
      );
    }
  }
  // 反向：预发布段的数字**必须**按数值比较（这是合成号的排序依据）。
  if (compare('0.2.1-alpha.1.3', '0.2.1-alpha.1.10') >= 0) {
    problems.push(
      `守卫 2：0.2.1-alpha.1.3 应**小于** 0.2.1-alpha.1.10（数字标识符按数值比较），` +
        `实得 ${compare('0.2.1-alpha.1.3', '0.2.1-alpha.1.10')}。合成号的排序键因此失效。`,
    );
  }
  if (compare('0.2.1-alpha.1.10', '0.2.1-alpha.2.1') >= 0) {
    problems.push(
      `守卫 2：0.2.1-alpha.1.10 应**小于** 0.2.1-alpha.2.1（上游预发布段优先级更高），` +
        `实得 ${compare('0.2.1-alpha.1.10', '0.2.1-alpha.2.1')}。`,
    );
  }
  return problems;
}

/**
 * **守卫 3**：通道解析不得静默回落。
 *
 * 被探测的两个入口**参数化**注入，便于自测注入「会返回 null 的旧实现」。
 *
 * @param {object} [impl]
 * @param {(v: string) => (string|null)} [impl.byPrerelease] - 默认 {@link channelOfPrerelease}。
 * @param {(v: string) => (string|null)} [impl.forVersion] - 默认 {@link targetForVersion}。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkChannelStrictness(impl = {}) {
  const byPrerelease = impl.byPrerelease ?? channelOfPrerelease;
  const forVersion = impl.forVersion ?? targetForVersion;
  const problems = [];

  // 非法形状必须**抛错**，不得返回任何值。
  for (const bad of ['0.2.1.3-rc.1', '0.2', 'not-a-version', '']) {
    try {
      const got = byPrerelease(bad);
      problems.push(
        `守卫 3：channelOfPrerelease(${JSON.stringify(bad)}) 应当抛错，实际返回 ${JSON.stringify(got)}。` +
          `早期实现把「格式不符」与「无预发布后缀」合并成同一个 null ⇒ 静默落回默认目标，` +
          `按**错的**补丁集组装而不报错（缺口 2i）。`,
      );
    } catch {
      /* 预期内 */
    }
    try {
      const got = forVersion(bad);
      problems.push(
        `守卫 3：targetForVersion(${JSON.stringify(bad)}) 应当抛错，实际返回 ${JSON.stringify(got)}。` +
          `若它返回 ${JSON.stringify(got)}，说明四段式被静默当成某个目标——产物会装错通道。`,
      );
    } catch {
      /* 预期内 */
    }
  }

  // 合成号的通道判定必须只看**首**标识符（它属上游），不看本仓序号。
  const positives = [
    ['0.2.1-alpha.1.3', 'alpha'],
    ['0.2.1-alpha.1.10', 'alpha'],
    ['0.2.0-rc.3.1', 'next'],
  ];
  for (const [version, expected] of positives) {
    let got;
    try {
      got = forVersion(version);
    } catch (error) {
      problems.push(`守卫 3：targetForVersion(${version}) 不应当抛错：${error.message}`);
      continue;
    }
    if (got !== expected) {
      problems.push(`守卫 3：targetForVersion(${version}) 应为 ${expected}，实为 ${JSON.stringify(got)}。`);
    }
  }
  return problems;
}

/**
 * 真检查：读台账并跑三条守卫。**台账为空时必须显式说出「这是空集判据」**。
 *
 * @param {string} [root] - 仓库根路径。
 * @returns {{ problems: string[], notices: string[] }}
 */
export function verifyAll(root = process.cwd()) {
  const notices = [];
  const ledger = readLedger(root);
  const builds = allBuilds(ledger);
  const problems = [
    ...checkLedgerInvariants(ledger),
    ...checkBuildMetadataNotOrdered(),
    ...checkChannelStrictness(),
  ];
  if (builds.length === 0) {
    notices.push(
      '台账 builds[] 为空：合成号机制（ADR-061）尚无发布 ⇒ 守卫 1 的**记录层**是空集判据' +
        '（索引层不受影响，它已在核对在役目标的覆盖）。守卫 2 / 3 也不受影响——它们探测的是' +
        '实现而不是台账。这不是通过，是没有可断言的对象。',
    );
  }
  return { problems, notices };
}

/**
 * 纯逻辑自测。**含注入式可伪证夹具**：把已知有缺陷的实现喂给守卫，断言它报红。
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

  const build = (n) => ({
    channel: 'alpha',
    n,
    desktopVersion: `0.2.1-alpha.1.${n}`,
    tag: `v0.2.1-alpha.1.${n}`,
    date: '2026-10-08',
  });

  // 台账必须**按键索引**（上游身份的唯一产地是键；见 release-ledger 模块文档）。
  // ⚠️ 自测用**小型**目标总表：真实 DSH_TARGETS 的覆盖要求会随锚点变动，
  //    把它拉进纯逻辑自测 = 让自测随配置漂红（判据设计陷阱：断言绑上了外部状态）。
  // ⚠️ 必须带 `publishChannel`：索引层用它现算 releaseChannel（台账不存该字段）。
  const TARGETS = { alpha: { dshVersion: '0.2.1-alpha.1', status: 'active', publishChannel: 'alpha' } };
  const ledgerOf = (builds, upstreamDsh = '0.2.1-alpha.1') => ({
    schemaVersion: 1,
    releases: {
      [upstreamDsh]: { patchTarget: 'alpha', upstreamDistTag: 'alpha', status: 'active', builds },
    },
  });

  // 守卫 1：索引覆盖 / 合法序列 / 重复二元组 / n 空洞 / core 段被改写，五种都要覆盖。
  eq('守卫 1：覆盖在役目标且 builds 为空 → 通过（空集不是失败）', checkLedgerInvariants(ledgerOf([]), TARGETS), []);
  eq('守卫 1：连续序列通过', checkLedgerInvariants(ledgerOf([build(1), build(2)]), TARGETS), []);
  eq('守卫 1：重复二元组报红', checkLedgerInvariants(ledgerOf([build(1), build(1)]), TARGETS).length > 0, true);
  eq('守卫 1：n 空洞报红', checkLedgerInvariants(ledgerOf([build(2)]), TARGETS).length > 0, true);
  eq(
    '守卫 1：core 段被本仓改写必须报红',
    checkLedgerInvariants(ledgerOf([{ ...build(1), desktopVersion: '9.9.9-alpha.1.1', tag: 'v9.9.9-alpha.1.1' }]), TARGETS)
      .length > 0,
    true,
  );
  // 🔴 **接线断言**：这条证明 targets 真的被传进了索引层。少了它，「索引层其实没在查」
  //    与「索引层查了且通过」会给出同一个绿——正是本仓那条「扫描器坏了与真的没有东西
  //    长得一模一样」的缺陷族。
  eq(
    '守卫 1：漏掉在役目标的键必须报红（证明索引层真在查）',
    checkLedgerInvariants({ schemaVersion: 1, releases: {} }, TARGETS).some((p) => p.includes('alpha')),
    true,
  );

  eq('守卫 2：本仓比较器通过', checkBuildMetadataNotOrdered(), []);
  // 🔴 注入式可伪证夹具：一个「比较 build」的比较器（= Rust `Ord` 的语义）必须被判红。
  const buildAware = (a, b) => {
    const strip = (v) => v.split('+')[0];
    const ba = a.includes('+') ? a.split('+')[1] : '';
    const bb = b.includes('+') ? b.split('+')[1] : '';
    if (strip(a) !== strip(b)) return strip(a) < strip(b) ? -1 : 1;
    if (ba === bb) return 0;
    return ba < bb ? -1 : 1;
  };
  eq('守卫 2（伪证）：比较 build 的实现必须被判红', checkBuildMetadataNotOrdered(buildAware).length > 0, true);
  eq(
    '守卫 2（伪证）：报错必须点明是 w 出了问题',
    checkBuildMetadataNotOrdered(buildAware).some((p) => p.includes('+w')),
    true,
  );
  // 🔴 反向伪证：一个无视预发布段数值比较的实现必须被判红（否则守卫 2 只查一半）。
  const lexicographic = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  eq('守卫 2（伪证）：按字典序比较的实现必须被判红', checkBuildMetadataNotOrdered(lexicographic).length > 0, true);

  eq('守卫 3：本仓实现通过', checkChannelStrictness(), []);
  // 🔴 注入式可伪证夹具：缺口 2i 的**旧实现**（非法形状返回 null）必须被判红。
  const oldByPrerelease = (v) => {
    const m = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim().replace(/^v/i, ''));
    return m ? (m[1] === undefined ? null : m[1].split('.')[0]) : null;
  };
  const oldForVersion = (v) => {
    const suffix = oldByPrerelease(v);
    if (suffix === null) return 'next';
    return suffix === 'alpha' ? 'alpha' : suffix === 'rc' ? 'next' : null;
  };
  eq(
    '守卫 3（伪证）：缺口 2i 的旧实现必须被判红',
    checkChannelStrictness({ byPrerelease: oldByPrerelease, forVersion: oldForVersion }).length > 0,
    true,
  );
  eq(
    '守卫 3（伪证）：报错必须点出四段式被静默当成目标',
    checkChannelStrictness({ byPrerelease: oldByPrerelease, forVersion: oldForVersion }).some((p) => p.includes('0.2.1.3-rc.1')),
    true,
  );

  // 真检查的可跑性由 CLI 路径覆盖（selfTest 保持**纯逻辑**、不读磁盘）。
  // 🔴 摊平接线：记录层的报错必须能点出**上游键**。记录里**不存** `upstreamDsh`，它由
  //    `allBuilds` 从索引键附着 ⇒ 若附着断了，这里的文案会变成 `releases[undefined]`。
  eq(
    '接线：记录层报错点出上游键（upstreamDsh 由索引键附着）',
    checkLedgerInvariants(ledgerOf([{ ...build(1), tag: '' }]), TARGETS).some((p) => p.includes('releases[0.2.1-alpha.1]')),
    true,
  );

  if (failures.length > 0) {
    throw new Error(`verify-version 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  }
  return { passed };
}

const USAGE = `verify-version.mjs — 版本策略的三条守卫（docs/version-policy.md §7.1）

  （无参数）    真检查：读台账 + 探测比较器与通道解析
  --self-test   纯逻辑自测（含注入式可伪证夹具）
  --help        显示本帮助`;

/**
 * CLI 主入口。
 *
 * @param {string[]} args - `process.argv.slice(2)`。
 * @returns {number} 退出码（0 成功 / 1 守卫判红 / 2 用法错误）。
 */
function main(args) {
  if (args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--self-test')) {
    const { passed } = selfTest();
    console.log(`✅ verify-version 自测通过（${passed} 项）`);
    return 0;
  }
  const { problems, notices } = verifyAll();
  for (const notice of notices) console.warn(`⚠️  ${notice}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    console.error(`\n版本策略守卫失败（${problems.length} 项）`);
    return 1;
  }
  console.log('✅ 版本策略守卫通过（守卫 1 台账一致性 / 守卫 2 w 不参与排序 / 守卫 3 通道解析严格）');
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
