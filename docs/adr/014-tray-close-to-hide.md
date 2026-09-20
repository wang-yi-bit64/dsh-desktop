# ADR-014 — 托盘关窗=隐藏到托盘；app.exit() 不经 CloseRequested 故 shutdown 是必经点

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-18（批次 0.2-B1） |
| 唯一产地 | `src-tauri/src/tray.rs`、`src-tauri/src/window.rs::reveal_main_window`、`lib.rs::shutdown` |

## 背景

批次 0.2-B1 做系统托盘 + 关窗驻留，一次性推翻了 `menu.rs` 模块文档里两句
「当时看起来合理、实际不成立」的断言（两句都已就地更正，此处记录原因）：

1. **「`muda::MenuItem` 是 `Rc`，非 `Send`/`Sync`，不能放进托管状态」**——对 `muda`
   成立，对 Tauri 的包装类型不成立：`tauri::menu::MenuItem<R>` 是
   `Arc<MenuItemInner<R>>`，`MenuItemInner` 由 `gen_wrappers!` 宏带着
   `unsafe impl Send/Sync` 生成（每次访问都经 `run_on_main_thread` 派发）。
   该结论曾把实现推向「每次重新定位句柄」，而 `TrayIcon` 只有 `set_menu`、
   **没有 `menu()` 读取器**——这条路在托盘上根本不存在。
2. **「状态刷新走 `AppHandle::menu()` 定位句柄」**也行不通：`Menu::get` /
   `Submenu::get` 只查直接子项且不跨菜单，应用菜单与托盘里的同名项是**两份**
   独立对象。只刷一处就会「菜单说已连接、托盘说未启动」，而用户最可能看的
   正是托盘那一份 → `refresh_bridge_status` 同刷两处。

## 决策

1. **0.2-决策点 2 = A**：关窗 = 隐藏到托盘。`on_window_event` 拦 `CloseRequested`
   → `prevent_close` + `hide`；二次启动与托盘点击共用 `reveal_main_window`
   （show → unminimize → focus 三步）。
2. **托盘创建失败的环境回退到 B**（关窗即退出）：隐藏一个没有托盘入口可唤回的窗口
   等于让进程无从触达；判据是 `tray_by_id(TRAY_ID).is_some()`。
3. **`app.exit()` 不经过 `CloseRequested`**：把关窗改成隐藏后，若退出路径仍只调
   `app.exit(0)`，唯一的停机点就消失了，Harness 只能被 JobObject / PDEATHSIG
   强杀（来不及落盘收尾）。因此 `lib.rs::shutdown`（先收手机桥、再收 Harness）成为
   **所有** Quit 路径的必经点：`menu.rs` 的 `app-quit`、`commands.rs` 的 `app_quit`
   与 `recovery_action:"quit"`。
4. **托盘后端缺失时不得拖崩启动**：gtk 后端在缺库时 `panic!`
   （`libappindicator-sys` 用 `Lazy<Library>`，探不到
   `libayatana-appindicator3.so.1` / `libappindicator3.so.1` 两个名字即 panic）。
   先 `dlopen` 探测同样的两个名字，探不到就返回错误、不进入会 panic 的路径；
   外加 `catch_unwind` 兜住其它 panic 点（如临时图标文件写失败也会 unwrap）。
   `lib.rs` 只记 error 日志，**应用照常启动**——改动前那种机器上应用本来是能起的。

## 备选方案与取舍

- **B：关窗即退出、托盘仅快速入口**：否决（作为默认）。与自启动配合时不是常驻形态；
  仅保留为创建失败时的回退。
- **直接 `builder.build()` 靠 catch_unwind**：否决。panic 从 `setup` 穿出会把应用
  整个带崩——等于给「本来能启动的机器」引入启动期回归，而 `dlopen` 预探可以
  根本不进入该路径。

## 后果

- 托盘与应用菜单**共用同一批菜单 id**（`menu::MENU_ID_*`）与同一个
  `handle_menu_event`，「加了菜单项忘了接处理器」成为一类点了没反应的缺陷
  → 由 `verify:ipc-surface` 的 **E7** 钉住（只认 match 臂与守卫式早退两种合法写法）。
- ⚠️ **托盘没有自动门禁**：CI 容器里没有托盘区，L2 冒烟测不了托盘的存在与交互。
  不要因为「门禁全绿」就认为托盘在三平台都验过；实测/未实测分界与三平台手工清单
  在 `docs/dev-plan-0.2-hardening.md` 批次 0.2-B1 执行记录。

## 守卫与证据

- `verify:ipc-surface` E7（三组夹具：缺分支 / 守卫式早退 / 注释里的 id）。
- `verify:ipc-surface` 全量 + L1/L2 冒烟覆盖命令面与启动链路；托盘交互本身
  仅有三平台手工验收（见上）。
