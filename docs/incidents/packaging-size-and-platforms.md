# 体积与平台原生变体事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。

### 上游靠 optionalDependencies 塞进整套外部程序：安装包体积翻倍（2026-09-18 实测，**预期行为**）

`v0.6.0-alpha.2` 的安装包比 `alpha.1` **翻了一倍多**（Windows 53.6 → 126.3 MB、dmg 81.3 → 170.1 MB），
四个平台**同时**增大。根因不是打包配置出错，而是上游 alpha.2 新增的文档预览能力把**一整套
LibreOffice** 装进了运行时：

| 包 | unpackedSize | 说明 |
|---|---|---|
| `@deepseek-ai/libreoffice-kit-win32-x64` | 325.1 MB | ≈ 我们看到的资源树增量（+324.8 MB） |
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | 255.1 MB | macOS 那份 |
| `@deepseek-ai/libreoffice-kit-wasm` | 185.4 MB | wasm 回退 |

依赖链是 `@deepseek-ai/dsh-office-to-pdf` →（**普通 `dependencies`**）`libreoffice-kit`
→（`optionalDependencies`）`libreoffice-kit-<platform>`——**npm 按平台只装一个**，
这是上游的有意设计，不是误装。

**判据（下次再遇到体积翻倍时按这个查）**：
1. **看是不是全平台一起涨**。全平台涨 → 资源树内容变化；只有某个平台涨 → 平台相关打包问题。
2. **`du -sm staging/node_modules/@deepseek-ai/* | sort -rn`** 找出体积主项——新建的外部程序包
   会立刻显形（本例 330 MB 对第二名 8 MB，一眼可见）。
3. **查依赖链的声明位置**：在 `dependencies` 里就是必装的；在 `optionalDependencies` 里
   是按平台/可选装的。这决定「能不能剪」以及「剪了会失去什么功能」。

> ⚠️ **这类体积变化必须在升级时主动记录，不能等用户来问**。`docs/dsh-upgrade-checklist.md`
> Step 6 早已要求「增量异常（> 30MB）时确认原因」并写入 `release` job summary 的
> `report-bundle-size`——但 2026-09-18 那次 alpha.2 升级**漏跑了这一步**，体积翻倍两小时后
> 由用户发现。**体积对比与补丁验证同等重要**：补丁失败会让应用起不来，体积失控会让用户不再
> 下载（这两者都是「交付质量」的一部分）。

**本仓的取舍（已裁定，2026-09-18）**：**接受**这个体积。理由是文档预览是上游新增的
用户可见能力，剪掉它等于本仓单方面删功能，与「不删上游能力」的一贯口径冲突；
真要减重应走上游（让 LibreOffice 变成真正的可选组件，由用户按需下载）。

### linuxdeploy 撞上外来平台原生变体：AppImage 打包的静默杀手（已修复，勿回归）

Linux 的 `build` job 曾**连续多轮**以 `failed to run linuxdeploy` 收场，而 tauri-bundler 在默认日志级别下**吞掉 linuxdeploy 的 stderr**，CI 上只留下一句无信息量的错误（deb 正常，因为 deb 不解析 ELF 依赖；Windows/macOS 不经过 linuxdeploy，全绿——所以红灯只出现在一个平台）。用 `-v` 拿到真实报错才定位：

```
Deploying dependencies for ELF file …/@koromix/koffi-linux-x64/musl_x64/koffi.node
ERROR: Could not find dependency: libc.musl-x86_64.so.1
ERROR: Failed to deploy dependencies for existing files
```

根因：linuxdeploy 会遍历 AppDir 内**每一个** ELF 并解析其动态依赖。`@koromix/koffi-linux-x64` 在同一个包里并列 glibc 与 musl 两份构建，`node-pty` 的 `prebuilds/` 也带齐所有平台架构——其中 musl 变体依赖 `libc.musl-x86_64.so.1`，在 glibc 的 ubuntu runner 上**必然**解析失败，于是整个 AppImage 打包被拖垮。附带噪声（非致命）：静态链接的 `landlock-run` 让 patchelf 打 ERROR、跨架构的 arm64 `pty.node` 走 ldd 只给警告——同源，都是「树里混进了与目标无关的二进制」。

修法：`prepare:harness` 在瘦身之后、打包之前调用 [`scripts/prune-platform-variants.mjs`](scripts/prune-platform-variants.mjs) 剪掉外来变体。判据**有界**，只对「选择器写在哪里明确的四种布局」动手——`prebuilds/`（prebuildify 约定，其 loader 按 `platform-arch` 查找）、koffi 的 `musl_*` 布局、裸 libc 目录名、以及**包名里的 libc 选择器**（第 4 类，2026-09-23 新增，见下一小节）。包**名**里带平台后缀的要分两个维度看：**os/cpu 维度** npm 确实已过滤（不碰）；**libc 维度** npm **过滤不了**（必须碰，否则打包必红）。另有一道保险：prebuilds 目录之外只对**有同平台邻居**的目录按名删，永远不会删掉「最后一个能用的」；第 4 类判据有同构的安全丝（同层必须存在 glibc 对应物）。剪掉它们不影响运行时——我们发布的 node 是 glibc 链接的，koffi 按运行时 libc 选构建，sharp 由 `detect-libc` 选包。

`npm run verify:variants` 把判据钉住，并带**可伪证性检查**：把**现有**瘦身门禁 `pruneNodeModules()` 作用于同一棵树，必须复现出「`musl_x64/koffi.node` 原样幸存」——证明这个缺陷**逃得过当时全部门禁**（静态检查、L1 烟雾、Windows/macOS 打包全部看不出），断言才不是装饰。

#### 复发（2026-09-12，rc.1 升级引入新布局）：裸 libc 目录名

0.1.5-rc.1 引入新原生依赖 `@deepseek-ai/node-addon-system-linux-x64`，其布局是**裸 libc 名**：
`bin/glibc/system.node` 与 `bin/musl/system.node` 并列。旧判据的安全丝 `oursIsHere` 只认
`linux-x64` / `linux_x64`，**不认裸名 `glibc`**——于是 `bin/musl` 逃过剪枝，linuxdeploy 又在它
上面 `Failed to run ldd`，Linux 打包再次失败。

**修法**：Linux 目标的保留名补上 `glibc`（我们的产物就是 glibc 链接的），安全丝才能认出
「同层有我们的变体」。`verify:variants` 加了该布局的夹具与断言，含一条反向断言：
**没有 glibc 邻居的孤独 `bin/musl` 必须保留**——证明删除是「有邻居」驱动的，不是见到 musl 就删。

#### 复发（2026-09-23，又一次「被前置失败掩盖」）：**libc 是 npm 不过滤的第三个维度**

修好 L1 的 FFI 事故之后，smoke 三平台**首次**真正跑到 `Build installers`，于是这个从未
被执行过的步骤立刻红了一个平台（`smoke 35856722738`：Windows ✓、macOS ✓、**ubuntu ✗**）：

```
Deploying dependencies for ELF file …/harness/node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.4.node
ERROR: Could not find dependency: libc.musl-x86_64.so.1
failed to bundle project: `failed to run ~/.cache/tauri/linuxdeploy-x86_64.AppImage`
```

根因不是 koffi，而是 `@img/sharp`：它的 bin 包用**包名**区分 libc
（`sharp-linux-x64` vs `sharp-linuxmusl-x64`），而 `@img/sharp-linuxmusl-x64@0.35.4`
在 lockfile 里**只声明** `os:["linux"]` / `cpu:["x64"]`，**没有 `libc` 字段**。
npm **只在包自己声明了 `libc` 时才按 libc 过滤**（`os`/`cpu`/`libc` 是三个独立维度），
于是 glibc 版与 musl 版**双双进树**，linuxdeploy 遍历到 musl 的 `.node` 必然失败。

这直接推翻了旧文档里那句「包**名**里带平台后缀的不碰——npm 已按 `os`/`cpu` 过滤」：
那句话对 os/cpu **是对的**，对 libc **是错的**，而 libc 恰好是 sharp 用来区分变体的维度。

**修法**：`prune-platform-variants.mjs` 新增**第 4 类判据**——「包名里的 libc 选择器」：

- 只对 `platform === 'linux'` 生效（本仓只发 glibc 链接的 Linux 产物；将来若加 musl 目标
  必须整体翻转，否则会删掉目标平台唯一的构建）；
- 名字替换是**整体 token**（`linuxmusl` → `linux`），因此带 scope 与中间词的
  `@img/sharp-libvips-linuxmusl-x64` 也命中；
- **安全丝**：同层必须存在 glibc 对应物才删——与「有邻居才删」同构，
  永远不会删掉「最后一个能用的」；
- 删掉不伤运行时：sharp 由 `detect-libc` 按运行环境选包，glibc 环境只加载 `sharp-linux-x64`。

`verify:variants` 19 → **29 项**：新增 sharp 两种布局的夹具（含 `libvips` 带中间词的形态、
以及**没有 glibc 对应物的孤独 musl 包必须保留**）、非 linux 目标不得按 libc 剪枝、
以及一条可伪证性断言（现有 `pruneNodeModules` 对该布局完全无感，musl 包必然幸存）。

> **升级 DSH 时请复核**：新版可能再带来新的「平台选择器」写法。现在判据是**四类有界**的
> （prebuilds 目录内、`musl_*` 目录、裸 libc 目录名、包名里的 libc 选择器），新布局不会自动
> 被覆盖——打包若再报 `failed to run linuxdeploy`，先 `-v` 看**是哪个 ELF** 的依赖解析失败，
> 再核对这里的四类判据。⚠️ 尤其注意「包名带平台后缀」这一类：先判它选的是 **os/cpu**
> （npm 会过滤，别碰）还是 **libc**（npm 不过滤，必须碰）。

#### 复发（2026-10-07，同一条判据、换了一种命名约定）：**后缀式 `-musl`**

上一节那句「升级 DSH 时请复核」在两周后就应验了：`0.2.1-alpha.1` 带来一族新的 libc 选择器写法，
形态与 sharp 那次**不同**，于是第 4 类判据（当时只认**连写**的 `linuxmusl`）没有命中，
`Build installers` 在 ubuntu 上**再次**失败（smoke `37635305716`：macOS ✓、Windows ✓、**ubuntu ✗**）：

```
Deploying dependencies for ELF file …/harness/node_modules/node-addon-require-builtin-linux-x64-musl/prebuilt/linux-x64-musl-napi-v9.node
ERROR: Could not find dependency: libc.musl-x86_64.so.1
ERROR: Failed to deploy dependencies for existing files
failed to bundle project: `failed to run ~/.cache/tauri/linuxdeploy-…-x86_64.AppImage`
```

根因同源，但**多了一层变化**：`node-addon-require-builtin@0.1.7` 用**后缀 token** 区分 libc
（`…-linux-x64-gnu` 与 `…-linux-x64-musl` 并列），且 **0.2.1-alpha.1 起这一族在 lockfile 里
连 `libc` 字段都不再声明**（对照：next 线 `0.2.0-rc.2` 的 `…-linux-x64-gnu` 曾声明
`libc:["glibc"]`，且当时根本没有 musl 变体）。两件事叠加 ⇒ npm 认为 gnu 与 musl **同样适用**，
把两份都装进树。**判据只覆盖了一种命名约定，是这次漏出去的真正原因。**

**修法**：第 4 类判据从「一个映射」放宽为「**一组候选**」——`glibcSiblingCandidates()` 同时给出

- **连写**：把 `linuxmusl` 换成 `linux`（`@img/sharp` 布局）；
- **后缀 token**：把 `musl` token 换成 `gnu`，以及「整个 token 去掉」的候选（napi-rs 布局）。

命中**任一候选**且**该名确实存在于同一层**才删。安全丝的语义不变（仍是「有实证的 glibc 对应物才删」），
只是把「对应物」由单名放宽为候选集合——因此上游**再换命名约定时本模块多半无需再改**。

`verify:variants` 29 → **38 项**：新增后缀式布局的夹具与断言（含「只有 musl、同层**没有**
`-gnu` 对应物的孤独包必须保留」）、非 linux 目标不得按 libc 剪后缀式包，以及一条可伪证性断言
（现有 `pruneNodeModules` 对该布局同样完全无感）。

> **升级时的一条通用判据**（两次复发提炼）：漏出去的从来不是「没识别出 musl」，而是
> **「同一个 libc 维度换了书写方式」**。复核时不要只对关键词，而要对**维度**：
> 先在 lockfile 里列出「同族名字里同时存在 A 与 B 两个变体、且两者都没声明 `libc`」的包，
> 再逐族判断 A/B 之间哪个是目标 libc。

