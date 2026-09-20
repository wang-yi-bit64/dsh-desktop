# ADR-027 — 工作流变量走 env:，不插进 run: 字符串

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-15（首次双通道 Smoke 实测） |
| 唯一产地 | `.github/workflows/release.yml`、`smoke.yml` |

## 背景

首次双通道 Smoke 出现**三平台结论相反**的局面：Windows 的 job 红，macOS/Linux 正常。
日志指向 `node scripts/prepare-harness.mjs --dsh-target=`（**空值**），因为
workflow 里写的是：

```yaml
run: npm run prepare:harness -- --dsh-target="${DSH_TARGET}"
```

Windows runner 的**默认 shell 是 PowerShell**（不是 bash），那行里的变量引用没有被
展开成期望的值，参数退化成 `--dsh-target=`，node 读到空串后按设计抛错。macOS/Linux
的 bash 正确展开，于是同一份工作流在两个平台上给出相反的结论——**根因只是 shell
不同**。

## 决策

目标名走**环境变量**，不要插进 `run:` 字符串：

```yaml
env:
  DSH_TARGET: ${{ needs.preflight.outputs.dsh_target }}
run: npm run prepare:harness
```

`resolveDshTargetArg()` 因此支持三条来源，优先级为 **CLI 参数 > `DSH_TARGET` 环境
变量 > 默认目标**。本仓口径：**能用 env 就用 env**（与给 `TAURI_SIGNING_PRIVATE_KEY`
用 env 而非内联插值是同一套理由——那次防密钥进日志，这次防 shell 改写语义）；
确实需要插值时，先问「Windows 的 PowerShell 会不会给出不同结果」。

## 备选方案与取舍

- **所有平台显式 `shell: bash`**：否决。依赖读者记得每个 `run:` 都加 shell 声明，
  漏一个就复发；env 方案是结构上不依赖 shell 语义。
- **插值前在 bash 里 `set -euo pipefail` 之类的防御**：否决。防御的是「变量为空」，
  不是「变量没被展开」——PowerShell 下前者甚至不会触发。

## 后果

- 任何「把 `${{ … }}` 插进 `run:` 字符串当参数」的写法都有同类隐患，本条成为
  写 workflow 的默认纪律。
- 环境变量分支引入后，「环境变量里的未知目标必须报错」也成为硬约束
  （静默回退默认目标 = 捆错运行时，见 ADR-022 决策 2）。

## 守卫与证据

- `verify:release-workflow` 的 `checkDualChannelShape`（组装步骤必须是
  `env: DSH_TARGET` + `npm run prepare:harness` 的形状）+
  `findInterpolatedTargetArg`（扫「`--dsh-target=` 与 `${{ … }}` 同行」）。
- `dsh-targets.mjs --self-test` 四条环境变量分支断言（含未知目标必须报错）。
