# LAN 手机桥对抗性审计（V2，2026-10-28）

> 对象：`src-tauri/src/mobile_bridge.rs`（LAN 手机桥）。
> 分支：`feat/v2-mobile-bridge-adversarial`。
> 纪律：本文每一条结论都必须能在**代码 + 测试名**上落地；落不了地的写「未核对」，
> 不写「应该没问题」。宣称纪律见 `AGENTS.md` §7。

## 0. 前提核实（先看这一节，否则后面所有编号都缺少锚点）

派发的任务书要求先读 `docs/dev-plan-external-assessment-response.md` §3 V2，并以
其中的 V2-1 ~ V2-8 为准。**该文件在本仓库不存在**，实测：

| 核实动作 | 命令 | 结果 |
|---|---|---|
| 该路径是否曾存在 | `git log --all --oneline -- docs/dev-plan-external-assessment-response.md` | 无任何输出 |
| 全分支是否有 V2 编号 | `git grep -n "v2_8" $(git rev-list --all --max-count=50)` | 无任何输出 |
| 本地是否有该文件 | `ls docs/dev-plan-external-assessment-response.md` | `No such file or directory` |

⇒ 结论：**八项判据的定义来源不存在**，仓库里也没有任何 `v2_*` 测试在执行。
因此本档采取的口径是：

1. 派发任务书里**逐字给出**的五项（V2-1 / V2-2 / V2-6 / V2-7 及三条问题测试）
   按任务书原文实现，编号照用；
2. 任务书未逐字定义的三项（V2-3 / V2-4 / V2-5 / V2-8 的具体边界）由本档在
   §2 里**自行定义**并标注「本次定义」，不冒充「按计划执行」；
3. 「修三条问题测试」这一动作在本分支**无对象可修**——`v2_4` / `v2_5` / `v2_8`
   三条测试此前并不存在。实际交付是**按正确形态新写**这三条，并在 §2 里写明
   被否掉的错误写法（死端口断言 200、另建 state、未鉴权断言 403）以及为什么
   它们是错的。

这条记录本身也受 §7 约束：它说的是「依据缺失」，不是「依据已对齐」。

## 1. 改动面

| 文件 | 改动 |
|---|---|
| `src-tauri/src/mobile_bridge.rs` | 鉴权、转发链、日志三处实现 + 15 条测试（含负例） |
| `crates/dsh-contracts/src/constants.rs` | 新增 **CX-18**（转发链的时间/体积/并发上限） |
| `docs/incidents/mobile-bridge-audit.md` | 本档 |
| `SECURITY.md` | 「明示边界」加一行指针 |

刻意未动（任务书禁止）：`state.rs`、`crates/dsh-host/**`、`scripts/gate-manifest.mjs`、
`patches/`、计划文档 §8。

## 2. 八项逐条结论

> ⚠️ 读法：「✅ 已修」= **代码与测试已就位**，不等于「CI 已验证」——本轮 CI 未被触发
> （原因与凭据缺口见 §8.3）。CI 一旦给出颜色，本节与 §8.3 必须同步更新。

| 编号 | 判据 | 结论 | 代码证据 | 测试（含负例） |
|---|---|---|---|---|
| V2-1 | 监听绑定只在 `start`；`stop` 后端口真的可重绑 | ✅ 已修（并发现一处竞态） | `MobileBridge::start` / `stop`；`shutdown: watch` 通道 | `v2_1_tcp_listener_bind_is_confined_to_start`（静态，带植入夹具）、`v2_1_stop_releases_the_port_for_rebinding`（含「监听中绑不上」对照） |
| V2-2 | `supplied.contains(token)` → 精确 Bearer 匹配 | ✅ 已修 | `bearer_matches` + `ct_eq` | `v2_2_bearer_token_must_match_exactly`、`v2_2_substring_authorization_is_rejected_over_the_handler` |
| V2-3 | 请求体上限 413 / 非 JSON 400 | ✅ 实现本已存在，本次补测试并统一常量 | `MOBILE_BRIDGE_MAX_REQUEST_BYTES`（CX-18）检查 + `serde_json::from_slice` | `v2_3_oversized_body_is_413_and_malformed_json_is_400`（负例：合法请求→503） |
| V2-4 | 上游状态码透传；**不得**对死端口断言 200 | ✅ 测试写法已修 | `forward_request` | `v2_4_forward_returns_the_upstream_status_verbatim`、`v2_4_dead_upstream_is_502_never_200` |
| V2-5 | 端到端必须操作 `bridge.state`，不得新建 state | ✅ 测试写法已修 | `rpc_forward(State<Arc<BridgeState>>)` | `v2_5_round_trip_through_the_bridge_state`、`v2_5_a_fresh_state_rejects_the_session_bridge_state_accepts` |
| V2-6 | 全链超时 + 响应体上限 + 并发上限（429） | ✅ 已修 | `forward_request_with_limits`（建连/写/读空闲/总时长/体积）+ `forward_slots: Semaphore` | `v2_6_slow_upstream_trips_the_read_idle_timeout`、`v2_6_oversized_response_is_rejected_instead_of_buffered`、`v2_6_the_n_plus_first_concurrent_forward_is_429` |
| V2-7 | `eprintln!` → 可捕获日志门面；日志/401 不含完整 token/cookie | ✅ 已修 | `log::warn!` + `scrub_secrets` / `redact_secret` / `describe_authorization` | `v2_7_logs_and_401_body_never_carry_the_secret`、`v2_7_scrub_secrets_removes_token_and_cookie_values` |
| V2-8 | 先鉴权，鉴权后才断言 403；无鉴权→401 | ✅ 代码顺序本就正确，缺的是**钉住顺序的测试** | `rpc_forward` 的检查顺序 | `v2_8_401_before_403_and_403_only_after_auth`（负例：白名单内方法不得 403） |

### V2-1 端口生命周期

**实现**：绑定点收敛为一处，位于 `MobileBridge::start`（用户显式动作），静态守卫
扫出数断言为 1（`AGENTS.md` §7.3：扫出数为 0 时先怀疑扫描器，故同时给了植入夹具）。

**发现（本项唯一的代码级缺陷）**：`stop()` 原本用
`Notify::notify_waiters()`。tokio 的 `notify_waiters` **只唤醒当前已在等待的任务、
不保存许可**；而 `start()` 在 spawn 完 serve 任务后**紧接着**做握手，未注入 Harness
目标时握手立刻失败返回——窗口只有微秒级。若 `stop()` 落在这个窗口内，通知就丢了：
serve 任务永远不关监听器，端口一直被占，而 `port` 字段已被置 `None`，快照看不出
任何异常（这正是 §7.1 规则 3 禁止的无声降级）。

**修法**：改用 `watch::channel(false)` 每轮 start 一条独立通道，`stop()` 发送
`true` 并从状态里 `take()` 走 sender（重复 stop 变 no-op，也不会把「已停止」留给
下一轮）。`watch` 保存**最新值**，接收方无论何时开始等都不会漏掉已发生的翻转。

**未解风险**：端口释放仍取决于 graceful shutdown 的收敛速度（本测试给了 5 s 上界）。
若进程内有长连接被 serve 持有，释放会被拖到该连接结束——本档不声称这是零延迟。

### V2-2 精确 Bearer

旧实现 `supplied.contains(token)` 的三种绕过（全部在新测试的负例里）：

| 头 | 旧实现 | 现在 |
|---|---|---|
| `Authorization: Bearer <token>extra` | 通过 | 401 |
| `Authorization: x<token>y` | 通过 | 401 |
| `Authorization: Basic <base64 里含 token>` | 通过 | 401 |

**实现**：方案名大小写不敏感（RFC 7235），后接**恰好**一个空格，值与令牌等长且
逐字节相同；比较走手写的 `ct_eq`（等长时不提前返回），避免用计时差逐字节恢复
令牌。**未解风险**：长度不等时立即返回，长度仍可从耗时区分——令牌长度是固定常量
（32 字节 hex），不构成可利用信息，但这不是「零侧信道」。

### V2-3 请求体上限与形状

`MAX_BODY_BYTES`（64 KiB）此前是模块内私有常量，现迁入 CX-18
（`MOBILE_BRIDGE_MAX_REQUEST_BYTES`）。判据顺序：体积检查在最前（与鉴权无关，
不泄漏任何信息）→ 鉴权 → JSON 形状 → 方法白名单。
**未解风险**：`/pair` 与 `/` 没有体积上限检查，只有 `/api/rpc` 有；`/pair` 的
请求体由 axum 的 `Json` 提取器读取，未设 `DefaultBodyLimit`（默认 2 MB）。

### V2-4 状态码透传（错误测试写法的正确形态）

被否掉的写法：对一个「确定没人监听」的端口断言 200。它的失败方式不是报错，而是
**永远绿或永远红**——取决于那台机器上有没有人占这个端口，与代码无关。

现在的形态：本地 stub upstream 返回 200 / 500，断言**原样透传**；死端口断言 502
（并显式断言 `!= 401`，防止「鉴权没过」被误当成「转发失败」）。
stub 用 `tokio::net::TcpListener` 起在 `127.0.0.1:0`，不依赖外网、不依赖 Node。

### V2-5 端到端必须操作 bridge.state

被否掉的写法：`rpc_forward` 的测试里另 `new()` 一份 state。后果很具体——会话令牌
存在**桥自己**的 state 里，新建的 state 里没有它，于是要么测试永远 401、要么作者
顺手把令牌也塞进新 state，测的就不再是产品的鉴权链路。

现在的形态：`MobileBridge::new()` → `start()`（真实监听 + 握手）→ 用原始 TCP
打 `/pair` → 再打 `/api/rpc` → stub 上游。并且断言 stub **确实收到了**
`Cookie: dsh-auth-4173=stub-cookie`——否则「已握手」只是一个没人读的字段。
负例 `v2_5_a_fresh_state_rejects_the_session_bridge_state_accepts` 把旧写法
的反面钉住：同一个令牌对新 state 必然 401。

### V2-6 转发链上限

| 环节 | 上限 | 常量（CX-18） |
|---|---|---|
| 建连 | 5 s | `MOBILE_BRIDGE_FORWARD_CONNECT_TIMEOUT` |
| 写出（头 + 体共用一次预算） | 5 s | `MOBILE_BRIDGE_FORWARD_WRITE_TIMEOUT` |
| 单次读（空闲） | 10 s | `MOBILE_BRIDGE_FORWARD_READ_TIMEOUT` |
| 整链总时长 | 20 s | `MOBILE_BRIDGE_FORWARD_TOTAL_TIMEOUT` |
| 响应体 | 4 MiB | `MOBILE_BRIDGE_MAX_RESPONSE_BYTES` |
| 响应头（独立检查） | 64 KiB | `MOBILE_BRIDGE_MAX_RESPONSE_HEAD_BYTES` |
| 并发 | 4，超出 429 | `MOBILE_BRIDGE_MAX_CONCURRENT_FORWARDS` |

响应头与响应体拆分后分别检查各自上限；总缓冲未达组合上限也不能放过超限响应头。
回归判据：`v2_6_response_head_cap_is_enforced_below_the_combined_cap`（响应头恰好
64 KiB 允许透传，多一个字节则拒绝，两者总缓冲均低于组合上限）。

为什么每一格都必要（都是被否掉过的缺口形态）：

- 只有建连超时 → 对端连上不发字节，`read_to_end` 无限等；
- 只有单次读超时 → 「每 9 秒吐 1 字节」可无限延长（故另有总时长）；
- 只有总时长、无体积上限 → 上游吐 1 GiB 会在**读完之前**把桥进程撑爆（桥是本机
  进程，却可被远程输入触发）；
- 并发用 `acquire()` 排队而不回 429 → 过载变成「手机侧转圈直到总超时」，调用方
  拿不到可退避的信号。

**未解风险**：429 的上限是**全桥共享**的 4，没有按设备区分——一台已配对设备可以
把另一台的配额吃满。当前消费面是「一到两台手机」，因此未做按令牌分桶；要做，
得先把 `BridgeState` 的会话模型从「单会话」改成「多会话」。

### V2-7 日志脱敏

`eprintln!` 的问题不是「不好看」：打包后的 GUI 进程没有控制台，`eprintln!` 的
输出**没有任何观察者**，因此「握手失败」这件事在用户机器上既不可见也**不可测**。
改为 `log::warn!` 后，测试可以装一个捕获 logger（`CaptureLogger`）对同一条路径断言。

脱敏分两层：

1. **结构化字段**（授权头）→ `describe_authorization`：只留方案名与 `<redacted:NB>`，
   连前 4 位都不留（短令牌留 4 位等于泄漏一半）；
2. **自由文本**（底层错误）→ `scrub_secrets`：把 `token=…` 与 `dsh-auth-…=…` 的值
   统一替换为 `<redacted>`，并对「无密钥部分必须保留」设了反向对照断言——否则
   「擦除」可以退化成「什么都看不见」而测试仍然绿。

### V2-8 鉴权顺序

代码顺序本来是「体积 → 鉴权 → JSON → 白名单」，**没有需要修的缺陷**；缺的是把
这个顺序钉住的测试。旧写法（未鉴权却断言 403）会把**顺序缺陷**当成契约：一旦有人
把白名单检查提到鉴权之前，那条测试仍然绿，而未授权者从此可以靠 401/403 的差异
枚举「桥放行了哪些方法」。

## 3. CORS / CSRF 边界

**结论**：桥**不加任何 CORS 中间件**，这是刻意的，不是遗漏。判据：

- `grep -rn -i "cors\|access-control" src-tauri/src/ src-tauri/frontend/` 只命中
  注释文字（本文档与模块头），**零处中间件、零处响应头**；
- 四个路由（`GET /`、`GET /health`、`POST /pair`、`POST /api/rpc`）都没有
  `Access-Control-Allow-Origin`，因此浏览器对跨源 `fetch` 会在预检阶段被拦下。

**CSRF 为什么打不动**（逐条，只列能在代码上核对的）：

| 攻击形态 | 被什么挡住 |
|---|---|
| 外部页面 `fetch` 打 `/api/rpc` | 需要自定义头 `Authorization` ⇒ 触发预检 ⇒ 无 CORS 响应头 ⇒ 浏览器不发实际请求 |
| 表单 POST 打 `/pair`（simple request） | `Json` 提取器要求 `Content-Type: application/json`，表单只能发 `application/x-www-form-urlencoded` / `text/plain` ⇒ 415 |
| 借 cookie 的「环境权限」打桥 | 桥**不给自己发任何 cookie**，浏览器没有可自动附带的凭据 ⇒ 没有环境权限可借 |

**未解风险（如实登记）**：

1. **DNS rebinding**：上述 CORS 分析的前提是「浏览器按 origin 执行同源策略」。攻击者
   若把自己的域名解析到 `192.168.x.x`，页面 origin 就是他自己的域名，桥仍会响应——
   但它仍然需要 `Authorization` 头（预检要 `Access-Control-Allow-Origin`，桥不给），
   所以拿不到 `/api/rpc`。这条**没有测试覆盖**，结论来自代码阅读。
2. **配对页把 token 写在 URL 里**：`GET /?token=…` 的 URL 会进浏览器历史；页面
   自身无任何外部资源（CSS/JS 全内联、无 `<img>`），因此没有 Referer 外泄面——
   `pair_page` 的 HTML 是唯一产地，改它的人必须同时守住这条。
3. `/pair` 无速率限制：24 字节随机令牌（192 bit）穷举不可行，但**没有**任何限流
   代码，这一点不宣称。

## 4. loopback 豁免理由

`SECURITY.md` 的威胁模型写「Harness 只监听 loopback」，而手机桥监听 `0.0.0.0`。
两者不矛盾，但必须说清豁免的四条前提：

1. **不是默认行为**：桥只在用户点菜单时绑定（静态守卫
   `v2_1_tcp_listener_bind_is_confined_to_start` 守着「绑定点只有一处且在 `start`」），
   应用启动不自动监听；
2. **不把启动 token 发给局域网**：`0.0.0.0` 暴露的是配对页与 `/api/rpc`，首航
   token 只经 `GET /?token=…` 交给**扫码的那台手机**；桥接层的 `/api/rpc` 使用
   `Authorization: Bearer <session>` 验证会话，`dsh-auth-*` cookie 仅由桥接层转发给
   上游 Harness，用于上游 `/api/*` 鉴权（契约 C5）；
3. **可随时收回**：菜单的停止项发出停止信号并吊销配对/会话凭据（`stop()` 清
   `pairing` 与 `session_token`），端口在后台 graceful shutdown 完成后释放；
   `v2_1` 的运行时测试允许最多 5 秒的重新绑定等待，不保证停止操作返回即释放；
4. **范围有限**：桥只放行 10 个方法（`harness_endpoint` 白名单），不是通用代理；
   未在白名单内的方法 403（`v2_8`）。

⇒ 因此威胁模型里那句「Harness 仅 loopback」限定的是 **Harness 自身**，不覆盖
用户显式开启的手机桥；桥的边界由本节四条规定。

## 5. glib：**未核对**（本档不替它背书）

`README.md` / `README.zh-CN.md` 的安全说明写「本项目未调用受影响的 API」
（`glib::VariantStrIter`，GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429）；
`deny.toml` 的注释则写「该 GHSA 在 RustSec 数据库无对应条目，实测 not found」。

**这两处口径都没有在本轮被验证**，本档如实记为**未核对**：

- 本仓**没有直接调用** `glib`（`grep -rn "glib::" src-tauri/src crates/` 零命中是
  可以核对的），但「Tauri 的 GTK 后端是否在受影响路径上调用 `VariantStrIter`」
  属于**上游代码**，本轮未读；
- 该依赖仅 Linux 生效（`cfg(target_os = "linux")` 链），本机 Windows 无法实测；
- 复核办法（未执行）：`cargo tree -i glib` 定位引入链 → 在
  `~/.cargo/registry` 的 `tauri` / `gtk` 源码里 `grep VariantStrIter` → 若命中，
  把 README 的「未调用」改成「经 X 间接调用，影响面见 GHSA」。

⇒ 在有人做完上面三步之前，README 那句应视为**未核对的既有宣称**；本档不把它
升级成「已核实」，也不擅自改写 README（不在本次改动范围）。

## 6. 密钥轮换预案

桥自己**不持有任何持久密钥**。四类凭据的寿命与轮换路径：

| 凭据 | 存放位置 | 寿命 | 泄漏后怎么轮换 |
|---|---|---|---|
| 启动 token（launch token） | Harness 进程内存 + `BridgeState.launch_token` | 每进程一次 | 重启应用即换新；桥不落盘，无需清理磁盘 |
| 配对 token | `BridgeState.pairing` | 5 min（CX-18 `MOBILE_BRIDGE_PAIRING_TTL_MS`） | 过期自动失效；菜单重开配对页即重新生成（`start` 先轮换再绑定） |
| 会话 token（`session`） | `BridgeState.session_token` | 直到 stop / 重新配对 | 菜单「停止」立即清空（`stop()`）；重新 `POST /pair` 会覆盖 |
| `dsh-auth-*` cookie | `BridgeState.auth_cookie`（仅内存） | 30 天（Harness 侧） | `set_harness_target()` 换目标时清空；应用重启后重新握手 |

**判定泄漏后的动作顺序**（写死，避免现场临时决定）：

1. 菜单停止手机桥（发出停止信号并吊销会话/配对；端口在 graceful shutdown 完成后释放）；
2. 重启应用（launch token 与 cookie 双双换新）；
3. 若怀疑是**局域网内**他人配对：先改路由器/关闭该网络的 AP 隔离问题，再开桥——
   桥只在受信网络开启（`SECURITY.md` 明示边界第 3 条）。

**未解风险**：`auth_cookie` 明文存在进程内存里，没有任何内存擦除（Rust 无
`mlock`/`zeroize`）。同机同用户的进程可读——但这与「单机单用户」威胁模型一致，
不声称做了额外防护。

## 7. E2E 安装实测（用户动作）——**未执行**

本轮**没有**跑过安装形态的真机 E2E（无 macOS/Windows 安装包在手、无第二台设备
扫码）。下面是给执行者的逐条动作与**预期可观察结果**，不是「已验证」：

| # | 用户动作 | 预期 |
|---|---|---|
| 1 | 安装最新构建 → 打开应用，等 Harness 就绪 | 主窗口加载本地 Harness 页；菜单 `Phone` 子菜单状态行为 `Phone Bridge: off` |
| 2 | 菜单 → `Phone Pairing (LAN)…` | 状态行变 `Phone Bridge: listening`（无 cookie 时是 `listening (unauth)`）；弹出配对页含二维码 |
| 3 | 手机（**同一局域网**）扫码 | 打开 `http://<ip>:<port>/?token=…`，页面显示二维码与「配对」按钮 |
| 4 | 手机点「配对」 | 页面显示「配对成功」；**桌面菜单状态行立刻变 `paired`**（这条就是 `on_connected_change` 的 E2E 证据） |
| 5 | 手机上发一条消息 | 消息经 `/api/rpc` 到 Harness，正常返回（无 401/502/503） |
| 6 | 桌面菜单 → `Stop Phone Bridge` | 发出停止信号并吊销会话/配对，状态行回 `off`；后台 graceful shutdown 完成后端口释放，手机刷新页面**连不上**（`v2_1` 测试允许最多 5 秒的重新绑定等待） |
| 7 | 关掉应用再打开，不点配对 | 状态行仍是 `off`（桥不自动监听） |
| 8 | 打开日志查看器搜 `mobile-bridge` | 只有 warn 级别的事件，且**不含**完整 token / cookie 串 |

第 4 步与第 6 步是这次改动的关键回归面（状态通知、端口释放）。

## 8. 验证与复现

### 8.1 本地能跑的（已跑）

| 命令 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | ✅ exit 0（改动前该命令在 `mobile_bridge.rs` 上无 diff；改后仍无 diff） |
| `rustfmt --edition 2021 --check src-tauri/src/mobile_bridge.rs` | ✅ exit 0（rustfmt 会**解析**整个文件，语法错误必然报错——这是本机唯一可用的语法级校验） |
| `npm run gate -- --tier=fast` | ❌ 48 步中 2 步失败，**均与环境有关、与本改动无关**（见下） |

`gate --tier=fast` 的两步失败，逐条给了归因证据：

| 失败步 | 报错 | 归因与证据 |
|---|---|---|
| `cli-package`（自检） | `tar: C\:\\...\\dsh-cli-selftest-*\tamper: Cannot open` | 本机 GNU tar 对 Windows 路径的转义问题。**把工作树 `git stash` 到干净 HEAD 后复跑，报同一句**——与本改动无关 |
| `cargo test --tests` | `error calling dlltool 'dlltool.exe': program not found`（编译 `windows-sys` 时） | GNU 工具链缺 `dlltool`，见 §8.2 |

### 8.2 本地**跑不了**的（如实记录，不是「没跑」）

`cargo test -p dsh-desktop --lib mobile_bridge` 在本机无法执行，两道独立的墙：

| 层 | 现象 | 归属 |
|---|---|---|
| 编译（build script 执行） | `error: could not execute process ...build-script-build (never executed) ... 拒绝访问。(os error 5)` | 本机环境（同族现象见 `docs/incidents/local-toolchain-limits.md` 的 `ERROR_PIPE_BUSY` 一节：本机无法为子进程建立 stdin 管道，node 侧报 `EBUSY`、Rust 侧报 pipe/access-denied） |
| 链接 | `error: error calling dlltool 'dlltool.exe': program not found` | GNU 工具链缺 `dlltool`；本机无 MSVC 工具链（`rustup toolchain list` 只有三个 gnu 工具链） |

与本文件记录的历史结论一致：**`src-tauri` 的单测只能编译、不能本地执行**
（缺 `api-ms-win-core-winrt-error-l1-1-0.dll`，加载期失败）。
⇒ 权威执行者是 CI 的 MSVC runner；本档不把「本地未跑」包装成「本地通过」。

### 8.3 CI：**本轮未触发（运行号：无）**

- 工作流定义：`.github/workflows/ci.yml` 的触发面是 `pull_request` / `workflow_dispatch` /
  `schedule`，**刻意不监听 `push`**（文件头有理由）。因此「推了分支」不会产生任何运行。
- 触发所需凭据在本机**不可用**，实测（含 2026-10-28 二次核对——连接器已重新授权）：

  | 通道 | 实测结果 |
  |---|---|
  | `gh` CLI | 未安装（`which gh` 无命中） |
  | `GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_PAT` | 均未设置 |
  | GitHub 连接器（**读**） | 用户完成授权后 `status: connected`；`get_me`（`wang-yi-bit64`）、`list_branches` 均成功 |
  | GitHub 连接器（**写**） | ❌ 开 PR 被拒：`POST /repos/wang-yi-bit64/dsh-desktop/pulls` → **403 `Resource not accessible by integration`**（安装令牌缺 `pull_requests: write`）。该连接器也未暴露 `workflow_dispatch` 能力 |

  ⇒ **读通了、写不通**。既不能开 PR，也不能 `workflow_dispatch`。依赖的检查
  （`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  `cargo test --workspace --tests`，其中 `cargo test` 覆盖本文件新增的 15 条测试）
  **一条都没跑过**。

- 推送时的快照：分支 `feat/v2-mobile-bridge-adversarial`，远端 SHA 与当时的本地 HEAD
  一致（`2e49e48`，含 `8ebc748`/`d3ac36a`/`2e49e48` 三个提交）；其后的提交不在此
  推送记录范围内。
- 与 `main` 的关系：落后 2 个 `chore(release)` 提交（`bfda0c2`、`f3efda2`），
  但这 2 个提交只动 `CHANGELOG.md` / `Cargo.lock` / `Cargo.toml` /
  `harness-locks/dsh-releases.json` / `package.json`，与本次改动的四个文件
  **零重叠**（`comm -12` 空输出）⇒ GitHub 的 test-merge 不会冲突，**无需先 rebase**。
- **待办（需要凭据的那一侧）**：开 PR 或对该分支 dispatch CI → 拿到运行号后回填本节，
  并把 §2 的结论按实际颜色同步（红色就写成红色，**不得**只改代码不改结论）。
  两条不需要 AI 会话接触凭据的路径：
  1. 浏览器直接打开
     `https://github.com/wang-yi-bit64/dsh-desktop/compare/main...feat/v2-mobile-bridge-adversarial?expand=1`
     → 点 `Create pull request`（已登录即可，一次点击）；
  2. 在**自己的**终端跑 `gh pr create --base main --head feat/v2-mobile-bridge-adversarial`
     （标题/正文可沿用提交信息）。

  在回填之前，本文档中的「✅ 已修」只表示**代码与测试已就位**，不表示「CI 验证通过」。

### 8.4 复现单条判据

```bash
# 只看本模块（CI 上的等价命令）
cargo test -p dsh-desktop --lib mobile_bridge -- --nocapture
# 逐条
cargo test -p dsh-desktop --lib mobile_bridge::tests::v2_2 -- --nocapture
```

## 9. 未解风险汇总

| # | 风险 | 为什么不修 | 判据 / 现场 |
|---|---|---|---|
| 1 | 无按设备分桶的并发配额 | 当前消费面是一到两台手机；改它要先把会话模型从单会话改成多会话 | `v2_6_the_n_plus_first_concurrent_forward_is_429` 只断言全桥上限 |
| 2 | DNS rebinding 只在纸面分析过 | 需要浏览器侧实验环境；结论依赖「无 CORS 头 + 必有 Authorization」 | 无测试，§3 已注明 |
| 3 | `/pair`、`/` 无体积上限 | axum 默认 2 MB 上限仍在；本次未加 | 代码内无 `DefaultBodyLimit` |
| 4 | 令牌比较的长度侧信道 | 长度是固定常量，不构成可利用信息 | `ct_eq` 注释 |
| 5 | glib 受影响 API 是否被上游调用 | 属上游代码，本轮未读 | §5 |
| 6 | E2E 未执行 | 无安装包与第二台设备 | §7 给了逐条动作，未标「已验证」 |
| 7 | `auth_cookie` 内存明文 | 与「单机单用户」威胁模型一致 | §6 |
