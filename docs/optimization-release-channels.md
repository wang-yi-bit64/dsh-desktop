# 发布通道重构：四项优化与落地建议

> 对象：`docs/dev-plan-release-channels.md`（主计划）与 `docs/risk-review-release-channels.md`（风险评审）
> 取证时间：2026-09-24（本文所有结论均由本机实跑得出，原始输出随文附上）
> 定位：**增量优化建议**，不改动主计划的分析框架与结论方向；只回答「怎么做」与「先做哪一步」。
> 纪律：延续风险评审的取证纪律——**不采信计划文档自身的事实陈述**。

---

## 0. 本次取证的 7 条硬结论（先看这个）

| # | 结论 | 影响对象 | 是否改写原判据 |
|---|---|---|---|
| C1 | Fastly 会缓存 `latest.json`，且 `Cache-Control: no-cache` **请求头绕不过** | 批次 5 验收 A | 🔴 **改写** |
| C2 | `verify-release-workflow.mjs` 第 4 条断言（「无 `gh release upload`」）**与 F13 修复直接冲突** | 批次 4 前半 / Hotfix | 🔴 **阻塞** |
| C3 | F13 的根因不是「忘了上传」，是**便携版 job 根本没有上传到 Release 的步骤** | Hotfix 范围 | 🔴 定范围 |
| C4 | 本仓 CI 缓存面**极窄**：只有 `setup-node` 的 npm cache（键 = `package-lock.json`） | 批次 2 清理动作 | 🟠 缩范围 |
| C5 | `dsh-targets.mjs` 的通道表**仍是 `next`，且锚点是硬编码的 `0.1.5-rc.2`**（比上游 `latest` 还旧） | 批次 1a / 2 | 🟠 前置 |
| C6 | 锁文件成本分摊机制**已经存在**（`ci` 模式 + CI 硬失败 + `harness:lockfile` 入口），缺口纯粹是**流程纪律** | §10 优化二 | 🟢 降级 |
| C7 | 正文**只有两段**有守卫（① 运行时横幅 ② 提交区间），第三段「CLI 下载表」**零判据** | 风险 5 | 🟠 已确认 |

关键的 C1 原始输出：

```text
$ curl -sIL -H 'Cache-Control: no-cache' \
    https://github.com/wang-yi-bit64/dsh-desktop/releases/download/v0.5.0-next.1/latest.json
HTTP/1.1 302 Found
  Cache-Control: no-cache           ← GitHub 这一跳确实声明不缓存
  Location: https://release-assets.githubusercontent.com/github-production-release-asset-...
HTTP/1.1 200 OK
  Content-Length: 5982
  Last-Modified: Tue, 15 Sep 2026 16:13:18 GMT
  ETag: "0x8DF1344418EE577"
  Via: 1.1 varnish, 1.1 varnish     ← Fastly 双层
  Age: 63                            ← 已经缓存了 63 秒，且持续增长
  X-Served-By: cache-iad-kiad7000194-IAD, cache-itm1220069-ITM
  X-Cache: MISS, HIT                 ← 客户端请求头没能穿透第二层
  X-Cache-Hits: 0, 1
```

连续多次取回 `Age` 单调递增（0 → 10 → 18 → 23 → 40 → 48 → 63），**且请求头里已经带了 `Cache-Control: no-cache`**。结论一句话：

> **GitHub 的 302 那一跳声明 `no-cache`，但真实资产落在 Azure Blob + Fastly 上，缓存由 Fastly 掌管，客户端请求头无权干涉。**

---

## 1. 滚动 Release（`latest.json`）的 CDN 缓存黑洞

### 1.1 问题定义（修正后）

计划原表述把风险描述为「Fastly 激进缓存导致收不到更新」。**描述方向对，但机制说反了一半**——重点不是「激进」，而是**它根本不看你的请求头**，而 `tauri-action` 生成的 `latest.json` 里带的 `version`、`pub_date`、`url` **全都会随每次覆写而变**，于是「缓存住旧 JSON」等价于「updater 判定无更新」。

风险的实际形态不是「更新晚到几小时」，而是三种，严重度递增：

| 形态 | 现象 | 严重度 |
|---|---|---|
| **R-D3-1 更新不可达** | `latest.json` 被缓存 ≥ 数小时，用户点检查更新被告知「已是最新」 | 🔴 高 |
| **R-D3-2 版本错配** | JSON 是新的但 `url` 指向的资产 tag 是旧的（或反之）——`--clobber` 覆写时若 JSON 与资产命中不同的缓存键，就会出现「读到新版本号、下载到旧包」 | 🔴 高 |
| **R-D3-3 签名失配** | JSON 里的 `signature` 是旧包的签名，`url` 是新包 → updater 验签失败，用户看到的是「更新损坏」而不是「没更新」 | 🔴 高 |

R-D3-3 是最坏的：它**看起来像 bug、不像缓存**，会把排障方向带偏。计划批次 5 目前没有专门构造它。

### 1.2 触发条件：什么时候必须切换到 Pages 静态托管

不要无条件切。**触发条件写成三条可判定的量**，任何一条成立即触发：

| 编号 | 触发条件 | 判据（怎么测） | 为什么是这个阈值 |
|---|---|---|---|
| **T1** | 实测 `Age` 超过一个预发布周期 | 见 §1.3 的 `probe-latest-cache.mjs`，`maxAge > 3600s` 连续两次 | rc/alpha 的典型发车间隔是天级；`Age` 到小时级就意味着「一批用户整轮收不到」 |
| **T2** | 覆写后 `version` 与 `url` 的 tag **不一致**（R-D3-2 实测出现） | 同一脚本的 `unpacked-version != json-version` 断言 | **一次都不要容忍**——这是确定性错配，不是概率问题 |
| **T3** | 验签失败在真机闭环里复现过一次 | §1.4 的真机闭环 | 出现即代表已有用户损坏 |

**明确不做的事**：不因为「担心 CDN」就提前上 Pages。Pages 引入的是**新的发布面**（一个新仓库/分支要维护、一个额外的部署 job、一个 `deploy-pages` 权限面），在 T1~T3 都没触发前它是净负债。这与 §9「明确不做」的精神一致：**先有用例，再有架构**。

### 1.3 切换成本评估

| 维度 | 从 Fastly（GitHub Release 资产）→ Pages 静态托管 | 实质工作量 |
|---|---|---|
| **端点改动** | `tauri.conf.json` 的 `plugins.updater.endpoints` 从 `releases/latest/download/latest.json` 改成自定义 URL | 1 处配置 + 1 处 `tauri.conf.json` 的 `pubkey` 不动 |
| **写入端** | 新增一个 job：生成 `latest.json` → commit 到 `gh-pages`（或 Pages artifact） | **这是主要成本**：要写 `scripts/publish-updater-manifest.mjs`，且 tauri-action 不再能代劳（它的 `uploadUpdaterJson` 只写 Release） |
| **`Cache-Control` 控制** | 唯一真正的收益：Pages 允许设 `Cache-Control: max-age=60, must-revalidate` | 落点：`gh-pages` 的 `_headers` 文件（Cloudflare Pages / Netlify）或 GitHub Pages 的**不可配置**问题 |
| 🔴 **关键坑** | **GitHub Pages 不让你设响应头。** 它硬编码 `Cache-Control: max-age=600`，无法覆盖 | 想真正控制 `Cache-Control` 必须换 Cloudflare Pages / Netlify / 自建 |
| **缓存破坏** | 无论落在哪，都不该依赖头。正确做法：**JSON 里加一个查询串**（`?v=<version>`）或**按版本命名**（`latest-0.7.1.json`） | 这**不需要换托管**，在 Release 资产上也能做 |

> **结论（明确表态）**：**不要为了 `Cache-Control` 去换 Pages。**
> `Cache-Control` 是「治标且不彻底」——你控制了自己这一跳的头，控制不了中间任何一跳。
> 真正根治的是**不可变命名 / cache-busting**，而它在 GitHub Release 上就能实现：
> updater 端点写 `releases/download/<immutable-tag>/latest.json`（tag 每次新版本都不同）
> 而不是 `releases/latest/download/latest.json`（这个别名恒定，所以必然被缓存）。
>
> **Pages 的正当理由只有一个**：当 `latest.json` **本身**需要是稳定 URL 而内容极少变化时。
> 但那正好与「每次覆写」的需求相反——所以对滚动 Release 这个场景，**Pages 并不是更优解**。
> 计划 §8.1 把静态托管列为唯一的回退方案，是**把手段当成了目的**。建议改为：
> **回退方案 = 不可变 URL（首选）→ 静态托管（次选，仅当 T2/T3 同时成立且不可变 URL 也失效时）**。

切换成本汇总（若真走到 Pages）：

| 项 | 成本 | 备注 |
|---|---|---|
| 新增 `scripts/publish-updater-manifest.mjs` | 中（~200 行 + 自测） | 需可证伪判据 |
| 新增 GitHub Pages / Cloudflare Pages 部署 job | 中 | 多一个权限面、多一个失败点 |
| `tauri.conf.json` 端点改造 + 客户端**已装用户**的迁移 | **高** | ⚠️ **已装用户读的是旧端点**，改端点后老用户永远收不到新端点 → 必须保留旧端点至少一个版本，**形成双写期** |
| 文档 / AGENTS §8 同步 | 低 | |

**最后一行被计划低估了**：`tauri.conf.json` 的 updater 端点是**编译进客户端的**，改它等于「从此以后所有老版本都走老路」。切 Pages 需要**双写过渡期**（Release 资产与 Pages 同时存在，直到旧端点下的用户升级完）。这条应写进计划的 §8.1。

### 1.4 夹具隔离要求

验收需要三种隔离，缺一不可：

| 夹具 | 隔离对象 | 要求 |
|---|---|---|
| **F-cache** | 缓存状态 | **不得**用「同一 URL 连续取回」做断言——那是共享夹具（Fastly 是全局的，你的测试结果会污染别人的、也会被别人污染）。必须用**每次不同的 query 串或路径**，保证冷启动：`probe-latest-cache.mjs?nonce=$(date +%s%N)` |
| **F-version** | 版本真实值 | 期望值**硬编码**在测试里，**禁止**用 `dsh-targets.mjs` 现算（本仓已踩过「自测与被测犯同一个错 → 对称失效」的坑，见工作记忆） |
| **F-e2e** | 真机更新闭环 | 必须真装旧版 → 触发更新 → 校验**新版本的 `signature` 对得上**。这一条**只能在真机做**，CI 里跑不了（要 GUI + NSIS 安装 + 重启） |

`probe-latest-cache.mjs` 的判据设计（三条，全部可证伪）：

```text
1. unpacked.json.version == 期望的常量版本   （硬编码，不现算）
2. url 里出现的 tag == 期望的 tag             （R-D3-2 的判据）
3. signature 非空 且 与 url 指向的 .sig 资产一致（R-D3-3 的判据，需下载比对）
```

⚠️ **不要写「Age 必须为 0」这类判据**——那是宿主机网络无关的，会随 CDN 抖动随机红/绿，
属于本仓反复踩的「按宿主环境分支的断言 = 只验一半」同族缺陷。

### 1.5 批次 5 验收 A 的判据修正（**必须改**）

计划原文（据风险评审 §4）：验收 A 用 `curl -H 'Cache-Control: no-cache'` 取回三次，
断言「不回退」。

**两处都错**：

1. `Cache-Control: no-cache` **实测无效**（C1）。取回的还是缓存副本。
2. 「不回退」是**错误判据**。若 `--clobber` 把旧清单覆盖了、三次取回**全是旧值且稳定**，
   「不回退」**反而通过**。稳定 ≠ 正确。

**改为**：

```text
判据 A（修正后）：
  A1. 取回三次，每次都断言 json.version == 本次发布的 new 版本（硬编码常量）
  A2. 且 json.url 里的 tag == 本次发布的 new tag
  A3. 每次用独立 nonce 破坏缓存（?nonce=< nanotime >），保证不是同一份副本
  A4. 三次全过 → 通过；任一次拿到旧值 → 记 FAIL 并输出 Age / X-Cache / X-Served-By
```

### 1.6 推荐的最小动作（先做这个，别先上 Pages）

**批次 5 落地前，先花半天做这三步**（不需要 Pages）：

1. **改端点**：`releases/latest/download/latest.json` → `releases/download/<tag>/latest.json`。
   tag 每次不同 → URL 天然不可变 → 缓存问题结构性消失。
   ⚠️ 代价：updater 端点是编译期常量，见 §1.3 末行的双写期问题。
   若不想动端点，退一步：**JSON 内的 `url` 指向的资产用带 tag 的路径**（这个 `url` 是运行期读的，可改）。
2. **加 `probe-latest-cache.mjs`**（§1.4 三条判据），接进 `verify:release-workflow` 的兄弟门禁。
3. **改验收 A 判据**（§1.5）。

Pages 作为 T1/T2/T3 触发后的**次选**回退，而不是首选。

---

## 2. `next → rc` 更名对存量离线数据的冲击

### 2.1 冲击面清点（`resolveTarget` 别名契约之外的部分）

计划已覆盖「`resolveTarget` 接受 `next` 别名」。**别名只解决「入参」**，不解决下面四类存量物：

| # | 存量物 | 位置 | 残留形态 | 失效表现 | 危险度 |
|---|---|---|---|---|---|
| **S1** | 组装好的资源树 | `src-tauri/resources/` | `MANIFEST.json` 里 `"target": "next"` | 新代码 `resolveTarget('next')` 返回 `rc` 目标，但 `prepare-harness` 的快速路径断言「MANIFEST.target == 本次目标」→ **不匹配 → 重新组装 300MB**（幂等性失效，只是变慢，不变错） | 🟠 中 |
| **S2** | staging 目录 | 由 `prepare-harness` 推导 | 目录名含 `next` | 更名后**新目录不存在 → 重新下载**；旧目录**永久残留**占磁盘 | 🟠 中 |
| **S3** | vendored 包 | `packages/next/*.tgz` | 文件名/路径含 `next` | `packagesDirFor` 返回新路径 → **找不到 tgz → 组装失败**（硬失败，好） | 🔴 高（但会报错） |
| **S4** | 补丁目录 | `patches/next/*.patch` | 同上 | `patchesDirFor` 返回新路径 → **找不到补丁 → 静默降级**（`patches/LAYERS.md` 的分级决定降级还是中断） | 🔴 **最高（可能静默）** |
| **S5** | lockfile + `inputs.json` | `harness-locks/next/` | 目录名 + 可能的内容引用 | `harness-lockfile.mjs` 按目标推导路径 | 🔴 高 |

> **S4 是真正的雷**：补丁找不到时按 `LAYERS.md` 分级，`brand` / `ui-behavior` 层**会降级不中断**。
> 于是产物「打出来了、能装、能跑」，只是**品牌/UI 补丁全丢**——而 `verify:harness-tree` 只看树健全性，
> 未必看得见某个补丁没应用。这属于本仓的**「被前置失败掩盖的潜伏缺陷」**族：更名本身不报错，
> 报错要等用户发现 UI 不对。
>
> **对策**：批次 2 必须给 `patches/<target>/` 加一条「目录必须存在且非空」的**硬断言**，
> 并让 `LAYERS.md` 的降级策略**不适用于「整个补丁目录缺失」**（那是配置错误，不是补丁冲突）。

### 2.2 缓存毒化的防范设计

**判据**：`MANIFEST.json` 的身份元组已含 `channel`（计划 §3）。所以**不需要发明新机制**——
只需要在更名时让**旧 MANIFEST 无法蒙混过关**。

现有身份元组：`(desktopVersion, dshVersion, channel, upstreamTag, lockfileHash, patchSetHash)`

`channel` 从 `next` 变 `rc` → 元组不同 → 快速路径必然失效 → 触发重新组装。**这是对的方向，但不够**：

| 缺口 | 说明 | 补法 |
|---|---|---|
| 元组比对是**「相等才复用」**还是**「不等才重建」**？ | 若实现是「只比部分字段」，`channel` 可能没进比对 | 加自测：构造 `channel` 不同的 MANIFEST，断言**不复用** |
| 旧 MANIFEST **物理残留**时，是否有「认错」的路径？ | 若快速路径只读 MANIFEST 不看目录名，可能复用 | 加自测：`resources/` 存在但 MANIFEST.target 与本次目标不同 → 断言**重建**（据工作记忆，这条**已有**：`prepare-harness.mjs` 幂等快速路径会校验 `target` 一致） |
| staging 旧目录残留 | 占磁盘、且若推导用「glob 匹配」可能命中 | 更名落地时**显式列出**要删的旧目录，不用 glob |

**关于 `inputs.json`（C6 相关）**：本机实测其结构为

```json
{ "dependencies": { "@deepseek-ai/dsh": "0.1.6-alpha.2", "node": "24.9.0", "pnpm": "10.34.5", ... },
  "overrides": { ... } }
```

**没有任何校验哈希字段**，也没有「这个 inputs 属于哪个版本」的自证。这意味着：
`harness-locks/<target>/inputs.json` 若被**误复制**到另一个目标目录，比对会**静默按新的键值走**。
更名时应顺带加一个 `target` 字段（自证身份），与 MANIFEST 的做法对齐。

### 2.3 批次 2 落地时「清理三平台 CI Cache」的具体动作

**先修正前提（C4）**：实测本仓 CI **没有**缓存 `resources/` / `harness-deps/` / staging。
缓存面只有：

```yaml
- uses: actions/setup-node@v5
  with:
    cache: npm
    cache-dependency-path: package-lock.json     # 唯一的缓存键
- uses: Swatinem/rust-cache@v2
  with:
    workspaces: |
      .
      src-tauri
```

所以「清理三平台 CI Cache」的**真实动作面**是：

| 缓存 | 是否受更名影响 | 需要清理吗 | 理由 |
|---|---|---|---|
| `setup-node` 的 npm cache（键 = `package-lock.json`） | ❌ 不受影响 | **不需要** | 键与目标名无关；且 npm cache 与「组装哪条通道」无关 |
| `Swatinem/rust-cache`（键含 `Cargo.lock` + rustc 版本） | ❌ 不受影响 | **不需要** | 更名不动 Rust 代码 |
| 任何自建的 `resources/` 缓存 | — | **本仓不存在** | grep 无匹配 |

> **结论：批次 2 不需要执行「清理三平台 CI Cache」这个动作。**
> 计划里这一条是**基于错误前提的待办**——它假设了 resources 被缓存。实测没有。
>
> 但**有一条真需要做的**：`actions/upload-artifact@v6` 的 `portable-windows`（release.yml:446）
> 与 workflow artifact 的保留期。更名后若有人**下载旧的 portable artifact** 做核验，
> 会拿到 `target:"next"` 的旧包。这不是 cache，是 artifact，清理方式是**版本化 artifact 名**
> （`portable-windows-next` → 直接用版本号），已在既有设计里（`package-portable.mjs` 的
> `portableBaseName(version)`）。

**所以批次 2 的正确待办是三条，不是「清 CI cache」**：

1. 在 `patches/<target>/` 加「目录必须存在且非空」的硬断言（堵 S4）。
2. 在 `harness-locks/<target>/inputs.json` 加 `target` 自证字段（堵 §2.2 末段）。
3. 检查本机（非 CI）的 `src-tauri/resources/MANIFEST.json` 与 staging 残留，
   写一份**显式路径清单**在批次 2 的落地步骤里（不 glob）。

---

## 3. §10 优化一：缺陷优先剥离（F13 作为 Hotfix 并入主干）

### 3.1 这个建议**成立**，而且比你说的更紧迫——因为 C2 是一道硬阻塞

**发现**：`scripts/verify-release-workflow.mjs` 的 `checkCliArtifactShape` 第 2 条断言是

```js
if (/gh release upload/.test(code)) {
  problems.push('release.yml 里仍有 `gh release upload`——上传通道退役后不应再有产物上传动作')
}
```

（`code` 已经过 `stripYamlComments()`，即注释里的引用不算数）

而 F13 的修复**必须**新增一个上传便携版到 Release 的动作。两条路：

| 路线 | 做法 | 代价 |
|---|---|---|
| **A. 用 `gh release upload`** | 最直白 | **直接撞守卫**，必须同时改守卫 |
| **B. 用 `tauri-action` / `softprops/action-gh-release`** | 绕开字符串 | 守卫看不见，但**引入第二个创建 Release 的 actor**，与 tauri-action 抢同一个 Release（`--clobber` 语义不明），风险更高 |

**建议走 A**，并把守卫**收紧**而不是放松：

```text
checkCliArtifactShape 第 2 条断言改为（三向）：
  2a. `gh release upload` 若出现，其参数必须只指向 dist/portable/*（准许的唯一下载物）
  2b. 不得出现 dist/cli/* 的上传路径（CLI 退役断言保持）
  2c. 不得出现 `cli` / `cli-publish` job（原有断言不变）
```

这样既放开 F13 的修复，又**不放开 CLI 复活**。⚠️ 且这条改动本身要有**两条互补夹具**：
「`gh release upload ... dist/portable/*`」放行 + 「`gh release upload ... dist/cli/*`」判红
（本仓已确立的注释剥离 + 互补夹具纪律）。

### 3.2 F13 的真实根因（**范围界定**）

`release.yml` 现在只有三个 job：`preflight` / `build` / `portable`。

- `build` 用 `tauri-action` → 它**自带**上传到 Release 的能力（安装包 + `.sig` + `latest.json`）。
- `portable` job 做完了打包（`package-portable.mjs` → `dist/portable/*`），
  然后 `actions/upload-artifact@v6` **只上传到 GitHub Actions workflow artifacts**，
  **没有任何一步把它挂到 Release 上**。

所以期望资产 13 = 9 安装包 + 1 `latest.json` + 3 便携版，
而实际只会得到 **10**（3 个便携版停在 Actions artifacts 里，不在 Release 上）。

**这不是「忘了调一次 `gh release upload`」，是「从来没写过这一步」**——
历史上那一步属于已删除的 `cli-publish` job。

### 3.3 优先级依据

| 依据 | 说明 |
|---|---|
| **它不依赖任何通道重构** | 只动 `release.yml` 的 `portable` job，与 `dsh-targets.mjs` / 目录更名 / `MANIFEST` 零交集 |
| **它的缺失是「确定性」的** | 下一个 tag 打出来，资产必是 10 不是 13。不是概率问题 |
| **它已被流水线化地踩过** | `v0.7.0-alpha.7` 是 22/22 全绿，此后 CLI 退役 → 期望值改 13，但**兑现路径没接上**。这是一次「口径改了、实现没跟」 |
| **它阻塞其他验收** | 批次 4 的验收（「13 资产」）在 F13 修好前**无法通过**。先修 F13，批次 4 的验收才有意义 |
| **改动面极小、可逆** | 新增一个「下载 artifact → `gh release upload`」的 job，约 30 行 YAML。失败只是资产少 3 个，不会破坏已有的 10 个 |
| **顺带暴露 C2 的结构冲突** | 早改早解决，避免通道重构做到一半发现守卫挡路 |

### 3.4 实施前置条件

| # | 前置 | 为什么 | 完成判据 |
|---|---|---|---|
| **P1** | 改 `checkCliArtifactShape` 第 2 条为三向断言（§3.1） | 否则 Hotfix 一提交，`verify:release-workflow` **恒红** | `npm run verify:release-workflow` 全绿 + 两条互补夹具通过 |
| **P2** | 确认 `gh release upload` 的 `--clobber` 语义与 tauri-action 不冲突 | 两者操作同一个 Release | 文档化：tauri-action 先建 Release，portable 后补 → **依赖 job 顺序**，用 `needs: [preflight, build]` |
| **P3** | `publish-assets` job 必须 `needs: build`（不能只 `needs: preflight`） | 否则 Release 还没建出来，上传找不到目标 | YAML 里有显式 `needs` 且守卫能断言它 |
| **P4** | 加一条**资产清单判据**（13 项，逐项枚举） | 这才是 F13 的真守卫。现状**没有任何判据断言资产数** | 新脚本或 `verify:release-workflow` 新增断言：期望 13 的名字列表逐项核对 |
| **P5** | 便携版 job 的 artifact 名带上版本 | 避免核验时下到旧 artifact | `portable-windows` → 含版本号 |

> **P4 是最重要的一条**。F13 之所以能藏这么久，是因为**守卫只管 CLI、不管资产数**。
> 「期望值 13」这个数字只写在 `AGENTS.md` 里，**没有任何可执行判据**。
> Hotfix 必须顺手补上，否则下次「口径改了实现没跟」还会发生。

### 3.5 建议的 Hotfix 形状

```yaml
  # 新增：把 portable 的三件套补挂到 Release 上。
  # 与 build job 的关系：tauri-action 在 build 里创建 Release（releaseDraft: false），
  # 因此本 job 必须 needs: build，否则 Release 还不存在。
  publish-assets:
    name: attach portable assets to the release
    needs: [preflight, build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v5
        with:
          name: portable-windows          # ← 见 P5：应改为含版本号的名字
          path: dist/portable
      - shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ needs.preflight.outputs.tag }}
        run: |
          set -euo pipefail
          ls -l dist/portable
          gh release upload "$TAG" dist/portable/* --clobber
```

**注意**：这个 job 在 `ubuntu-latest` 上跑，但下载的是 Windows artifact——`download-artifact` 跨平台无碍。

---

## 4. §10 优化二：锁文件生成成本分摊

### 4.1 结论：建议**成立**，但机制已经存在，缺口是**流程纪律**（C6）

实测确认本仓**已经**具备分摊所需的全部机制：

| 机制 | 位置 | 现状 |
|---|---|---|
| 生成入口 | `package.json` → `harness:lockfile` → `prepare-harness.mjs --update-lockfile` | ✅ 存在 |
| 提交式 lockfile | `harness-locks/<target>/package-lock.json` + `inputs.json` | ✅ 存在（4 个文件 = 2 目标 × 2 文件） |
| CI 零解析 | `prepare-harness.mjs` 的 `ci` 模式 = 复制 lockfile → `npm ci` | ✅ 存在 |
| CI 硬失败 | lockfile 缺失/失配 → `ci` 模式直接失败 | ✅ 存在 |
| 本地回退 | 非 CI 才允许在线解析 | ✅ 存在 |

**所以 §10 优化二不需要新设计，只需要写清纪律**：40 分钟 / 8GB 堆的 `npm install --package-lock-only`
**只在实施批次 1b 时跑一次**，产物作为静态资产提交。

### 4.2 但有一个被忽略的前置（C5）

`harness-locks/` **仍是通道键**（`alpha` / `next`），而计划 §5 批次 1a 要做
「换成版本键（如 `0.1.7-alpha.2/`）」。**版本键迁移是成本分摊的前置**——否则：

1. 你为 `next` 生成一份 lockfile 提交；
2. 批次 1a 把目录改成 `0.1.7-rc.1`；
3. **那份刚提交的 lockfile 立刻成为孤儿**，还得再生成一次（又 40 分钟）。

**这不是小事**。所以顺序必须是：

```text
批次 1a（目录更名 + 版本键迁移）
    ↓ 必须在生成 lockfile 之前完成
批次 1b（锚点对齐 → 生成 lockfile → 提交）
```

⚠️ 而 C5 还暴露一个更基本的问题：`dsh-targets.mjs` 的锚点是**硬编码的** `0.1.5-rc.2` / `0.1.6-alpha.2`，
而上游 `latest` 已经是 `0.1.5-rc.3`、`next` 是 `0.1.7-rc.1`。**打 tag 前必须先 `version:anchor -- set`**，
否则生成的 lockfile 锚在旧版本上，白跑 40 分钟。

### 4.3 实施前置条件

| # | 前置 | 完成判据 |
|---|---|---|
| **Q1** | 批次 1a 完成（`harness-locks/` 改版本键） | `ls harness-locks/` 不再是 `alpha`/`next` |
| **Q2** | `dsh-targets.mjs` 锚点已 `-- set` 到目标版本 | `npm run verify:drift` 的 level 为 `ok` |
| **Q3** | 三态网络核验通过（404/`ETARGET` → 阻断；网络失败重试 3 次 → 同样阻断；通过 → 记录时刻 + tarball sha） | 有可查的核验记录 |
| **Q4** | 生成**在本地或独立分支**完成，不占用 Release CI | 生成过程不出现在任何 workflow 的 `run:` 里 |
| **Q5** | 生成的 `package-lock.json` + `inputs.json` **成对提交** | 两文件同一次 commit |
| **Q6** | 提交后跑一次 `prepare-harness` 的 `ci` 模式验证可复现 | 本地/CI 能零解析装成 |

### 4.4 优先级依据

| 依据 | 说明 |
|---|---|
| **成本已量化且真实** | 40 分钟 / 8GB 堆。Release CI 上跑等于**每次发布多烧 40 分钟 × 3 平台**（或集中在 preflight 一次） |
| **它是纯前置换取** | 生成一次 → 之后每次发布零解析。**一次性成本换永久收益** |
| **CI 硬失败已经守住了正确性** | 缺 lockfile 会红，所以「忘记提交」不会静默发布错包——**风险是可控的** |
| **但它必须在 1a 之后** | §4.2 的孤儿问题。**顺序错了要重跑 40 分钟** |
| **不阻塞任何其他批次** | 它与 F13 / 通道契约层并行无依赖，可独立排期 |

### 4.5 注意：CI 侧只有 `preflight` 需要它

`release.yml` 里跑 `npm run prepare:harness` 的有两处：`build` job（三平台 matrix）与 `portable` job。
若 lockfile 已提交且 `ci` 模式生效，这三处都是零解析——**收益是三倍的**。

`preflight` 里跑的是 `verify:harness-lockfile`（34 项自测，纯逻辑），
**不依赖网络**，所以预检本身已经很快。这一点计划说对了。

---

## 5. 修正后的执行顺序（把四项优化排进去）

```text
① Hotfix：F13 便携版上传（§3）
   ├─ 前置 P1：改 checkCliArtifactShape 为三向断言（否则恒红）
   ├─ 前置 P4：加资产清单判据（13 项逐项枚举）← F13 的真守卫
   └─ 独立可发布，不等任何通道重构

② 批次 1a：目录更名 + 版本键迁移（patches/ harness-locks/）
   ├─ §2.1 S4 硬断言：patches/<target>/ 存在且非空（堵静默降级）
   └─ §2.2：inputs.json 加 target 自证字段

③ 批次 1b：锚点对齐（version:anchor -- set）
   └─ 然后**本地/独立分支**生成 lockfile（40min），成对提交（§4）
   ⚠️ 必须在 ① 之后：否则刚生成的 lockfile 立刻孤儿

④ §1 的最小动作（三选一，见 §1.6）
   ├─ 首选：改 updater 端点为不可变 tag 路径
   ├─ 加 probe-latest-cache.mjs（三条判据）
   └─ 改批次 5 验收 A 判据（§1.5）

⑤ 通道契约层重构（原计划批次 2 / 3 / 4 后半）
   └─ ⚠️ 不需要「清三平台 CI Cache」（§2.3）——这条待办基于错误前提

⑥ 批次 5（滚动 Release）
   └─ 触发条件 T1/T2/T3 全部未成立 → 不上 Pages（§1.2）
```

**顺序的两条硬约束**（顺序错了要返工）：

| 约束 | 违反后果 |
|---|---|
| ① 在 ③ 之前 | ③ 的 Hotfix 改动触碰 `release.yml`，而 ③ 刚生成的 lockfile 基于 ① 之前的 workflow——虽不直接冲突，但 ① 会改 `portable` job，③ 若已改过会产 rebase 冲突 |
| **② 在 ③ 之前** | **重跑 40 分钟**（§4.2 的孤儿） |

---

## 6. 与主计划 §10 的对照（哪些改了、哪些没动）

| §10 原项 | 本文的结论 | 变化 |
|---|---|---|
| 缺陷优先剥离（F13 Hotfix） | ✅ **强烈同意**，且更紧迫（C2 是硬阻塞） | **加强**；补 P4 资产清单判据 |
| 锁文件成本分摊 | ✅ 同意，但机制已存在 | **降级**为流程纪律；补 Q1/Q2 前置（含 C5 顺序） |
| 批次 5 缓存 | ✅ 成立 | **改写验收 A**（C1）；**否定 Pages 为首选**（§1.3） |
| next→rc 更名冲击 | ✅ 成立 | 新增 S4（**可能静默**）与「无需清 CI Cache」（C4） |
| §9「不为 CLI 设计发布形态」 | 不变 | — |
| 版本模型 A（列车+阶段） | 不变 | — |

---

## 7. 未决项（本文未给出结论，需另行裁定）

| # | 未决项 | 卡在哪 |
|---|---|---|
| U1 | updater 端点改不可变 tag 后的**双写过渡期**长度 | 需要知道存量用户版本分布（无法从仓库得知） |
| U2 | `latest.json` 是否需要一个**独立的 `channel-rc.json`** 之类多清单 | 取决于是否允许 rc 用户与 stable 用户读同一清单（安全边界问题） |
| U3 | `patches/<target>/` 存在性断言的**负向夹具**怎么造 | 需要能构造「目录缺失但组装有别的成功路径」的夹具 |
| U4 | `publish-assets` job 的失败是否应阻断发布 | 「资产少 3 个」是否算发布失败——建议**算**（期望值 13 是承诺） |
