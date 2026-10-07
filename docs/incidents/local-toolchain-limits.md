# 本地工具链已知环境限制

> 从 `AGENTS.md` §2 迁入，原样保留（GNU 工具链下的两条限制，不是代码问题）。

#### ⚠️ 已知环境限制：GNU 工具链下 Clippy 在旧 `dsh-model-gateway` 上 ICE（该 crate 已归档，条目仅留档）

同一台 `x86_64-pc-windows-gnu` 宿主机上，`cargo clippy --workspace` 曾在编译
`dsh-model-gateway` 时**编译器内部错误**（`the compiler unexpectedly panicked`，
rustc 1.97.1 / clippy 0.1.97），停在 `codegen_and_build_linker`。

- **性质**：clippy 自身缺陷（环境相关），与本仓库源码无关：同一命令在 `cargo check --workspace` 下完全通过。
- **现状（2026-09-11 已实测复核）**：该 crate 于 2026-09-10 随批次 F 从 workspace 移除后，
  **本机 `cargo clippy --workspace --all-targets -- -D warnings` 已可正常执行**（本地实跑 exit 0，
  增量构建约 6 秒）。也就是说：**现在本地就能复现 CI 的 clippy 失败，不必等 CI 报错再回头改。**
  这一点在 2026-09-11 修 `clippy::result_large_err` 时起了决定作用——先本地复现、再修、再本地验证通过，
  一轮闭环，没有消耗三平台 CI 跑一轮十几分钟的反馈时间。
  ⚠️ **仍不要把 clippy 当成「本地有没有都无所谓」**：触发该 ICE 的是一类「某个 crate 恰好触到
  clippy 代码生成路径」的环境问题，将来任何新 crate 都可能复现。因此：
  1. 本地首选 `cargo clippy --workspace --all-targets -- -D warnings`（与 CI 逐字一致）；
     若某天又 ICE，退回 `cargo check --workspace --all-targets`（能报出全部真实 warning，包括
     CI `-D warnings` 会拦下的 `unused_imports`）；
  2. clippy 的最终权威执行者仍是 CI（MSVC 工具链，三个平台都跑）——本地通过不等于三平台都通过。

#### ⚠️ 已知环境限制：GNU 工具链下 `dsh-desktop` 的测试二进制无法加载

在 **`x86_64-pc-windows-gnu`**（mingw）宿主机上，`cargo test -p dsh-desktop` 会失败：

```text
dsh_desktop_lib-<hash>.exe: error while loading shared libraries:
api-ms-win-core-winrt-error-l1-1-0.dll: cannot open shared object file
（或 STATUS_ENTRYPOINT_NOT_FOUND / 0xc0000139）
```

- **根因**：该导入来自 Tauri 无条件链接的 `webview2-com-sys`（WinRT）。本机 `System32` 与 `System32\downlevel` 下都没有该 API set DLL，GNU 运行时加载器不会去 MSVC 的解析路径找它。
- **性质**：失败发生在**动态加载阶段**，早于测试 harness 的 `main()`——因此与任何测试代码无关，也不会因源码改动而出现或消失。
- **后果**：`cargo test --workspace` 在本机必然失败；`src-tauri` 下的单元测试（含 `mobile_bridge.rs`）**只能编译、不能本地执行**。
- **怎么办**：
  1. 本地依赖上面第 1 条的**无头门禁**（不含 `src-tauri`，这正是 INV-6 的价值）；
  2. `src-tauri` 的行为由第 7 条的 L1/L2 烟雾覆盖（它派生真实进程，不依赖 Rust 单测）；
  3. `src-tauri` 单测的实际执行者是 CI——GitHub runner 用 **MSVC** 工具链，该导入可正常解析，故 CI 的 `cargo test --workspace` 有意义。
  4. 若本机需要跑这些单测，唯一可靠路径是切到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`），这不是代码问题。

#### ⚠️ 已知环境限制（2026-10-07 实测新增）：GNU 工具链下**链接整体失败**（`lld: unable to find library -lgcc / -lgcc_eh`）

> 与上面两条不同：这条**不是**某一类 crate 特有的，也不是运行期问题——它发生在
> **链接期**，因此 `clippy` / `check` / `test` / `build` 全都无法产出可执行物。
> 2026-10-07 alpha 线推进（B4 无头门禁）时首次撞上并定位。

在 `x86_64-pc-windows-gnu` 宿主机上，任何**需要链接成 `.exe` / `.dll` 的 Rust 产物**
（build script、proc-macro、测试二进制）都会失败：

```text
error: linking with `x86_64-w64-mingw32-gcc` failed: exit code: 1
  = note: clang-22: warning: argument unused during compilation: '-no-pie'
          lld: error: unable to find library -lgcc_eh
          lld: error: unable to find library -lgcc
```

- **触发面**：只要依赖图里有 `proc-macro2` / `quote` / `serde_core` / `icu_*_data`
  这类**必须落成 `.dll`/`.exe`** 的包即中招。纯 `.rlib` 编译（`--emit=metadata`/rlib，无链接）
  不受影响——这正是现场特征：`target/debug/deps/*.rlib` 有产物，而
  `target/debug/build/**/build_script_build-*.exe` **一个都不存在**
  （本机 `target/` 下 `.exe` 计数为 **0**，即**历史上从未成功链接过**）。
- **根因**：mingw 名下那个 `x86_64-w64-mingw32-gcc` **不是 GNU GCC**，而是 WinGet 安装的
  `MartinStorsjo.LLVM-MinGW.UCRT`（`clang-22`，`InstalledDir` 指向
  `AppData\Local\Microsoft\WinGet\Packages\...\llvm-mingw-20260616-ucrt-x86_64\bin`）。
  rustc 1.90 在 `x86_64-pc-windows-gnu` 上以 self-contained 方式让链接器解析
  `-lgcc` / `-lgcc_eh`（这两个 `.a` **确实存在**于
  `%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained\`），
  但该 clang/lld 驱动的默认库搜索路径里**没有**这个目录 ⇒ 解析失败。
- **性质**：环境问题，与仓库源码无关。**看到这个报错不要去改代码。**
- **本机没有 MSVC 退路**：`rustup` 中列出的 `stable-` / `1.90.0-x86_64-pc-windows-msvc` 是
  **残缺占位**（`the 'rustc.exe' binary ... is not applicable to the 'stable-x86_64-pc-windows-msvc' toolchain`），
  且机器上无 Visual Studio / Build Tools（找不到 `link.exe`、无 `vswhere`）。
  上面第 2 条给出的"切 MSVC"路径在本机**当前不可行**。
- **规避（已验证有效）**：把 self-contained 目录塞进 `LIBRARY_PATH`——clang 会把
  `LIBRARY_PATH` 翻译成它自己的 `-L`，从而补上缺失的搜索路径：

```bash
export LIBRARY_PATH="C:\\Users\\<user>\\.rustup\\toolchains\\1.90.0-x86_64-pc-windows-gnu\\lib\\rustlib\\x86_64-pc-windows-gnu\\lib\\self-contained"
cargo clippy --workspace --all-targets -- -D warnings
```

  最小复现已验证：裸 `rustc t.rs -o t.exe` 失败；同一个 crate 加上该变量后链接成功且产物可运行。
  （注意：`-C link-arg=-L<该目录>` 的写法实测**无效**，只有走 `LIBRARY_PATH` 才生效。）
- **权威执行者不变**：clippy / 三平台构建的最终权威仍是 **CI（MSVC runner）**；
  本机这次"绿"只是本地信号（同第 1 条）。
- ⚠️ **与本文件第 2 条叠加**：即使链接修好，`src-tauri` 的测试二进制在本机
  **运行期**仍会因缺 `api-ms-win-core-winrt-error-l1-1-0.dll` 而加载失败——
  **链接通过 ≠ 能跑**，`src-tauri` 单测本地依旧不可执行。

##### 同一条追补：`LIBRARY_PATH` 之后还会撞第二层——`dlltool` 失败

修掉 `-lgcc` 后会暴露下一层。`windows-link` / `windows` 系依赖走 `raw-dylib`，
rustc 需要为每个 DLL 生成 import library，于是去调 `dlltool`：

```text
error: Dlltool could not create import library with C:\Users\<user>\.cargo\bin\dlltool.exe -d … :
       C:\Users\<user>\.cargo\bin\dlltool.exe: CreateProcess
```

- **易误判点**：`<路径>: CreateProcess` 的外观很像"被安全软件拦了子进程"
  （本机确有 `spawnSync EBUSY` 前科，见 `AGENTS.md` §2）。**但它不是**。
  实测判据：把 rustc 的原样参数**从 bash 直接喂给同一个 exe**，**同样失败**并产出
  **0 字节**的 `.lib`——说明失败发生在 dlltool 内部，而非"谁拉起它"。
- **真根因**：`%USERPROFILE%\.cargo\bin\dlltool.exe` 是 **GNU Binutils 2.42 的 `dlltool`**，
  但那个目录里**没有配套的 `as`**（`as` / `nm` / `objdump` 全无），PATH 上也没有裸名 `as`
  （只有 llvm-mingw 的 `x86_64-w64-mingw32-as`）。dlltool 生成 import library 时必须
  调汇编器，找不到 ⇒ binutils 的 `pex` 层报 `CreateProcess`。**是一份不完整的 binutils 放置，不是安全软件。**
- **规避（已验证）**：让 rustc 改用 llvm-mingw 自带的 `llvm-dlltool`（它自带对象写入，
  不需要外部汇编器，且接受 GNU 风格参数）：

```bash
export RUSTFLAGS="-C dlltool=C:\\Users\\<user>\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\llvm-mingw-20260616-ucrt-x86_64\\bin\\llvm-dlltool.exe"
```

  实测：默认 dlltool 复现 `CreateProcess` 失败；换 `-C dlltool=<llvm-dlltool>` 后
  同一 raw-dylib 最小复现即链接成功、产物可运行。`x86_64-w64-mingw32-dlltool.exe` 亦可用。
- **本机跑 Rust 门禁的完整前置**（两条都要设）：`LIBRARY_PATH`（self-contained）
  + `RUSTFLAGS=-C dlltool=<llvm-dlltool>`。注意设 `RUSTFLAGS` 会改变 cargo 指纹、
  触发一次全量重建，属预期。
- **不要**为了让 dlltool 能用而往 `.cargo\bin` 补文件或改 `PATH` 顺序——那会动到用户环境；
  `-C dlltool=` 是作用域最小的那条路。

##### 同一条追补之二：第三层——`autocfg` 探针撞 `ERROR_PIPE_BUSY`，workspace 级编译整体失败

修掉前两层后，`cargo clippy --workspace --all-targets` / `cargo check --workspace --all-targets`
会停在**一个与源码无关的 E0107**：

```text
error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied
  --> …\schemars-0.8.22\src\lib.rs:12:32
12 | pub type Map<K, V> = indexmap::IndexMap<K, V>;
note: struct defined here, with 3 generic parameters: `K`, `V`, `S`
  --> …\indexmap-1.9.3\src\map.rs:76
76 | pub struct IndexMap<K, V, S> {
```

- **不是 clippy 特有**：`cargo check --workspace --all-targets` 本机**同样复现**（EXIT=101）。
- **根因链（逐段实证）**：
  1. `indexmap 1.9.3` 有两个形状：`#[cfg(has_std)] pub struct IndexMap<K, V, S = RandomState>`
     与 `#[cfg(not(has_std))] pub struct IndexMap<K, V, S>`（3 个泛型皆必填）。
  2. 它的 `build.rs`：未显式开启 `std` feature 时走 `autocfg::new().emit_sysroot_crate("std")`。
  3. autocfg 的**构造期自检**先编译一个**空探针库**
     （`rustc --crate-name … --crate-type=lib --out-dir <OUT_DIR> --emit=llvm-ir -`，源码从 stdin 灌入）；
     `probe_raw("")` 与 `probe_raw("#![no_std]")` **都失败**时才打印
     `warning: autocfg could not probe for `std`` 并**放弃发射 `has_std`**。
  4. 用**零依赖 scratch crate 复刻 autocfg 的 `probe_fmt`**，抓到真实报错：

```text
warning: acprobe@0.0.0: PROBE_SPAWN_ERR=所有的管道范例都在使用中。 (os error 231)
```

     即 Win32 **`ERROR_PIPE_BUSY`（231）**：管道实例耗尽，`Command::spawn` **连子进程都起不来**。
  5. ⇒ `has_std` 不发射 ⇒ indexmap 走 `no_std` 形状 ⇒ `schemars 0.8.22` 的 `IndexMap<K, V>`
     少一个泛型实参 ⇒ E0107。**依赖图里只要有 `tauri` / `schemars` 就会被它拦住。**
- **性质**：环境问题，与仓库源码无关（`indexmap`/`schemars` 都是 crates.io 上已发布的版本组合，
  `Cargo.lock` 未改）。它与本文档开头的 **`spawnSync EBUSY` 同族**——本机"进程 / 管道创建"
  资源被安全软件与进程规模挤压。
- **关键判据（别误判成代码问题）**：探针本身**没问题**。从 bash 手跑同样的 rustc 命令
  （含 `-C dlltool`、`CARGO_ENCODED_RUSTFLAGS`、`RUSTC_WORKSPACE_WRAPPER=clippy-driver` 包装）
  **五种组合全部 rc=0**；只有**在 cargo 构建脚本上下文里 spawn** 才失败。
- **可用面（本机实测）**：
  - ✅ **包级门禁不受影响**：`cargo clippy -p dsh-contracts -p dsh-host -p dsh-host-cli
    --all-targets -- -D warnings` 本机 **EXIT=0**（这三个 crate 的依赖图里没有 `tauri`/`schemars`）。
  - ⚠️ **workspace 级过不去**（`--workspace` 必然拖进 `src-tauri` → `tauri` → `schemars`）。
    clippy 与三平台构建的**权威执行者仍是 CI**。
  - 未逐一验证的缓解思路：降低并发（`-j 1`）、清 `target/debug/build/indexmap-*` 后重试
    （管道压力是瞬时量，重试可能成功）、关掉占用大量进程/句柄的程序。

##### 同一条追补之三：同一个 `ERROR_PIPE_BUSY` 也打掉**全部 rustdoc doctest**

`cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli` 本机实测（2026-10-07）：

| 阶段 | 结果 |
|---|---|
| `dsh-contracts` unittests | ✅ 16 passed / 0 failed |
| `dsh-host` unittests | ✅ **149 passed / 0 failed**（19.08s） |
| `args_forwarding` / `mock_launch` / `mock_lifecycle` / `quit_probe_live` | ✅ 8 / 8 / 5 / 1 passed |
| `dsh-host-cli` unittests / `cli_blackbox` | ✅ 4 / 6 passed |
| **Doctests** | ❌ **0 passed / 44 failed** |

**单测与集成测试全绿（合计 197 项），只有 doctest 阶段整段倒下**，且 44 个失败是**同一句**：

```text
thread '…' panicked at src\librustdoc\doctest.rs:674:38:
Failed to spawn rustc process: Os { code: 231, kind: Uncategorized, message: "所有的管道范例都在使用中。" }
```

- **性质**：rustdoc 为每个 doctest 派生一个 rustc 子进程，**在 `spawn` 阶段就被 `ERROR_PIPE_BUSY` 打掉**，
  **早于任何测试代码执行** ⇒ 与 doctest 内容无关，也与仓库源码无关。
- 与上面 autocfg 探针失败**是同一个根因**（同 `code: 231`），不是两个独立问题。
- **判据**：单测那 197 项恰恰证明"运行时"没问题（它们是真跑起来的 exe）；坏的只有"再派生带管道的子进程"这件事。
- **实践结论**：本机把 `cargo test -p <三 crate>` 的**单测部分**当作可用信号（绿），
  doctest 与 workspace 级 clippy 交给 CI；必要时在**低负载**时（例如没有并发 npm/组装任务时）
  清掉相关缓存后重试。

#### 🔓 已定位到可复现的单点根因（2026-10-07 追补）：`spawnSync … EBUSY` 的唯一触发器是**子进程 stdin 管道**

上面几条（`gates.mjs` 的 `spawnSync EBUSY`、`autocfg` 探针的 `code 231`、rustdoc doctest 的 `code 231`、
`koffi` 组装期回退 CMake）**不是四个问题，是同一个**。本轮把触发条件收敛到了一个可复现的单点。

**排除法（三个流行猜测都实测否掉）**：

| 猜测 | 实测方式 | 结果 |
|---|---|---|
| 本机安全软件（电脑管家）锁住 node.exe | 换成 Volta 系统 node 自 spawn | ❌ 仍 **10/10 失败** |
| WorkBuddy 经 `NODE_OPTIONS` 注入的 shim 作祟 | `env -u NODE_OPTIONS` 后重测 | ❌ 仍 **20/20 失败** |
| 上一轮 `node_modules` 残留被安全层删残 | 组装前确认 `harness-deps/<target>` **整体不存在**，纯从零 `npm ci` | ❌ 依旧失败（旧结论作废） |

**真根因矩阵**（`spawnSync(process.execPath, ['-e','1'], { stdio })`，各 20 次）：

| `stdio` 取值 | 结果 |
|---|---|
| 默认（等价 `'pipe'` = pipe/pipe/pipe） | ❌ `status=null`，`error.code = 'EBUSY'` |
| `['pipe','ignore','ignore']` | ❌ 同上 |
| `['ignore','pipe','pipe']` | ✅ `status=0`，**stdout 照常可读** |
| `['ignore','ignore','pipe']` | ✅ `status=0` |
| `'ignore'` / `'inherit'` | ✅ `status=0` |

由 stdio 只在 `stdio[0]` 上取值即可决定成败 ⇒ **唯一触发因子是「为子进程创建管道 stdin」**。
与 stdout/stderr 无关，与目标可执行文件无关，与父进程是 `bash` / `cmd.exe` / `node` 无关。
libuv 在 Windows 把 `STATUS_SHARING_VIOLATION` 归到 `UV_EBUSY`，故报错文本是 `EBUSY` 而非 `EPIPE`；
Rust 侧 rustc/rustdoc 则报 `ERROR_PIPE_BUSY (231)`——**同一现象的两套错误码**。

**规避层**（仓库外临时文件，`--require` 挂载，不改仓库任何代码）：

`%TEMP%\dsh-env\local-spawn-stdin-fix.cjs`

```js
// 仅把「会建 stdin 管道」的调用改写成 stdin:'ignore'；显式传 input / 已用 inherit|ignore 的原样放行
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) { /* 包一层 */ }
// 核心改写：stdio 为 'pipe'/默认 ⇒ ['ignore','pipe','pipe']
```

```bash
NODE_OPTIONS="--require=\"C:/Users/wangyi/AppData/Local/Temp/dsh-env/local-spawn-stdin-fix.cjs\"" \
  npm run gate -- --tier=fast      # 原本 100% 报 EBUSY，现可正常编排
```

**实测收益**：

| 场景 | 挂载前 | 挂载后 |
|---|---|---|
| `spawnSync(process.execPath, …, 默认 stdio)` × 20 | 20/20 失败 | **20/20 成功** |
| `npm run gate -- <name>` | ❌ `spawnSync … EBUSY` | ✅ 可编排（`--tier=fast` 共 45 步） |
| `prepare:harness` 组装（`koffi` 的 `cnoke` 预编译探针） | ❌ 回退 CMake ⇒ `npm ci` 退 1 | ✅ `EXIT=0`，**10/10 applied**，4m07s |
| `cargo` 侧 `autocfg` 探针 / rustdoc doctest | ❌ `code 231` | ❌ **仍失败（实测确认）**：`cargo clippy --workspace` 依旧 `E0107`；`cargo test -p dsh-host --doc` 依旧 44/44 `code: 231`，`--test-threads=1` 也一样 |

**统一表述（本机限制的唯一一句话口径）**：本机**无法为子进程建立 stdin 管道**——
node 侧报 `spawnSync … EBUSY`（可规避，因为 `stdio` 在我们手里），
Rust 侧报 `ERROR_PIPE_BUSY (231)`（**不可规避**：`autocfg` 把探针源码、`rustdoc --test` 把测试源码
都经 **stdin** 喂给 `rustc`，`cargo` 不提供改子进程 stdio 的口子）。
两类现象的实现路径不同（libuv vs Rust std），但都落在同一类系统调用上。

⚠️ **两条误导性报错必须记住**：
1. `koffi` 的 `Failed to load prebuilt binary, rebuilding from source` **不是真的加载失败**——
   是 `cnoke.cjs::checkPrebuild()` 那个 `spawnSync` 探针**没起来**（它只看 `proc.status === 0`，
   `null !== 0` 即被误判为"预编译不可用"）。`koffi` 包里**从来没有 `build/` 目录**，
   那是 cnoke 的输出目录；真实预编译产物在
   `node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`（实测存在且可 `require`）。
2. 不要因为报错里出现 `CMake` 就去装 CMake、或去翻"被删掉的产物"——**先查子进程能不能起来**。

**遗留边界**：本规避层只在**显式挂 `NODE_OPTIONS` 的那次调用**内生效，
不影响 WorkBuddy 自身的 shim 策略，也不写进仓库；CI（Linux runner）无此问题，无需任何改动。


