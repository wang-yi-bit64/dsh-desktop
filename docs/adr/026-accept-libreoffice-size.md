# ADR-026 — 接受上游 optionalDependencies 带入的 LibreOffice 体积

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-18 |
| 唯一产地 | `docs/dsh-upgrade-checklist.md` Step 6、`scripts/report-bundle-size.mjs` |

## 背景

`v0.6.0-alpha.2` 的安装包比 `alpha.1` **翻了一倍多**（Windows 53.6 → 126.3 MB、
dmg 81.3 → 170.1 MB），四个平台**同时**增大。根因不是打包配置出错：上游 alpha.2
新增的文档预览能力把**一整套 LibreOffice** 装进了运行时
（`@deepseek-ai/libreoffice-kit-win32-x64` 325.1 MB、
`-darwin-arm64` 255.1 MB、`-wasm` 185.4 MB）。依赖链是
`dsh-office-to-pdf` →（普通 `dependencies`）`libreoffice-kit` →
（`optionalDependencies`）`libreoffice-kit-<platform>`——**npm 按平台只装一个**，
这是上游的有意设计，不是误装。

## 决策

**接受这个体积。** 理由：文档预览是上游新增的用户可见能力，剪掉它等于本仓单方面
删功能，与「不删上游能力」的一贯口径冲突；真要减重应走上游（让 LibreOffice 变成
真正的可选组件、由用户按需下载）。

配套一条**升级纪律**：体积对比与补丁验证同等重要——alpha.2 那次漏跑了对比，
体积翻倍两小时后由用户发现。Step 6「增量异常（> 30MB）时确认原因」必须真的执行，
并写入 release job summary 的 `report-bundle-size`。

**判据（下次再遇到体积翻倍时按这个查）**：

1. **看是不是全平台一起涨**。全平台涨 → 资源树内容变化；只有某个平台涨 → 平台相关
   打包问题。
2. `du -sm staging/node_modules/@deepseek-ai/* | sort -rn` 找体积主项——新建的
   外部程序包会立刻显形（本例 330 MB 对第二名 8 MB，一眼可见）。
3. **查依赖链的声明位置**：在 `dependencies` 里就是必装的；在 `optionalDependencies`
   里是按平台/可选装的。这决定「能不能剪」以及「剪了会失去什么功能」。

## 备选方案与取舍

- **postinstall 删掉 libreoffice-kit**：否决。等于本仓单方面删除上游用户可见能力，
   且属于「无声降级」——用户拿到的是残缺功能而无人知晓（与 ADR-007 冲突）。
- **拆成按需下载的独立组件**：否决（本仓做）。要做也该在上游做，壳侧拆解只会得到
  两套分发路径都要维护。

## 后果

- 安装包体积基准永久抬升，README / Release 说明不再把「小巧」当卖点。
- 体积报告成为 release job summary 的常驻项，异常必须给出归因。

## 守卫与证据

- `npm run size:report`（壳二进制 / 安装包 / 资源树三口径）。
- `docs/dsh-upgrade-checklist.md` Step 6（> 30MB 增量须确认原因并记录）。
