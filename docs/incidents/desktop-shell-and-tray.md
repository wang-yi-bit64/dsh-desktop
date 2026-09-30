# 桌面壳与托盘事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。

### 托盘与 `menu.rs` 的两条前提被证伪（2026-09-18 批次 0.2-B1 实测）

托盘批次（`src-tauri/src/tray.rs`）一次性推翻了 `menu.rs` 模块文档里两句**当时看起来
合理、实际不成立**的断言。两句都还留在该模块文档里（已就地更正），这里记下原因，
**不要照着旧结论写代码**：

1. **「`muda::MenuItem` 是 `Rc`，非 `Send`/`Sync`，不能放进托管状态」——对 `muda` 成立，
   对 Tauri 的包装类型不成立。** `tauri::menu::MenuItem<R>` 是 `Arc<MenuItemInner<R>>`，
   而 `MenuItemInner` 由 `gen_wrappers!` 宏带着 `unsafe impl Send/Sync` 生成（每次访问都经
   `run_on_main_thread` 派发，句柄本身只是「远程控制句柄」）。因此 `TrayHandles { status,
   mobile_status }` 直接 `app.manage(...)` 是安全的。**推论**：那条「不能托管」的结论曾把
   实现推向「每次重新定位句柄」，而这条路在托盘上**根本不存在**——`TrayIcon` 只有
   `set_menu`，**没有 `menu()` 读取器**。
2. **「状态刷新走 `AppHandle::menu()` 定位句柄」也走不通。** `Menu::get` / `Submenu::get`
   **只查直接子项且不跨菜单**，所以应用菜单的 `Phone` 状态行与托盘里的同名项是**两份**
   独立对象，刷一处不会顺带刷另一处。只刷一处就会得到「菜单说已连接、托盘说未启动」——
   同一份状态的两种说法，而用户最可能看的正是托盘那一份。`refresh_bridge_status` 因此
   同刷两处。

**另外两条只有写代码才会撞上的约束（同样容易静默失效）**：

- **`app.exit()` 不经过 `CloseRequested`。** 托盘把关窗改成「隐藏」之后，如果退出路径仍
  只调 `app.exit(0)`，唯一的停机点就消失了，Harness 只能被 JobObject / PDEATHSIG **强杀**
  （来不及落盘收尾）。因此 `lib.rs::shutdown`（先收手机桥、再收 Harness）成为**所有** Quit
  路径的必经点：`menu.rs` 的 `app-quit`、`commands.rs` 的 `app_quit` 与 `recovery_action:"quit"`。
- **托盘的 gtk 后端在缺库时 `panic!`，会连带把应用启动带崩。** `libappindicator-sys` 把
  库句柄放在 `Lazy<Library>` 里，`libayatana-appindicator3.so.1` / `libappindicator3.so.1`
  两个名字都加载不到时**直接 panic**（其 `backcompat` 特性认无 `.1` 后缀的名字，**默认关闭**，
  所以只探这两个名字才准）。这个 panic 从 `builder.build()` 穿出 `setup` → 应用**整个**起不来，
  而改动前那种机器上应用是能正常启动的——等于引入了一个启动期回归。修法：`tray.rs::create`
  里先 `dlopen` 探测同样的两个名字，探不到就返回错误、**根本不进入**会 panic 的路径；
  外加 `catch_unwind` 兜住其它 panic 点（临时图标文件写失败也会 `unwrap`）。
  `lib.rs` 只记 error 日志，应用照常启动，关窗行为自动退回「关窗即退出」。

**守卫**：`verify:ipc-surface` 的 **E7**（菜单项 id ↔ `handle_menu_event` 分支）。托盘与应用
菜单**共用同一批 id**（`menu.rs` 的 `pub const MENU_ID_*`），而「加了菜单项忘了接处理器」
的后果是一个**点了完全没反应**的项——没有编译错误、没有日志、没有既有守卫能看见。
E7 只认两种合法写法：`match` 臂**与守卫式早退**（`if id == CONST { …; return }`，
`tray-show` 用的是后者）；只认前者会对正确实现误报（实测发生过）。`--self-test` 用三组夹具
（缺分支 / 守卫式早退 / 注释里的 id）钉住该判定本身，已进 CI 与 release preflight。

⚠️ **托盘没有自动门禁**：CI 容器里没有系统托盘区，L2 冒烟**测不了**托盘的存在与交互。
本项验收的实测 / 未实测分界与三平台手工清单写在
[`docs/dev-plan-0.2-hardening.md`](docs/dev-plan-0.2-hardening.md) 的「批次 0.2-B1 执行记录」——
**不要因为「门禁全绿」就认为托盘在三平台都验过**。

