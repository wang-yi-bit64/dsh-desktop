# DeepSeek Harness (DSH) 产物兼容、解耦与打包优化方案

> 针对 `scripts/prepare-harness.mjs` 构建产物庞大、碎文件多、`patch-package` 脆弱易失效的问题，提供全套演进设计与实施指导。

---

## 1. 现状架构痛点与根因分析

```
[npm registry] 
      │ (下载 @deepseek-ai/* 及依赖，数万文件)
      ▼
 [staging/] ──── (patch-package 行级 diff) ────► 脆弱，上游小版本升级即 conflict
      │
      ├─► node_modules/ 拷贝到 src-tauri/resources/ (300MB+，上万碎文件)
      └─► node.exe 拷贝到 src-tauri/resources/node/
```

1. **Patch 脆弱性**：`patches/` 目录中维护了 10 多个基于代码行号的 diff 文件，上游 package 发生哪怕一行的空行变化或变量名重构，构建就会失败中断。
2. **磁盘与 I/O 负担**：数万个碎文件在 Windows NTFS 文件系统上的拷贝、遍历和 Tauri 打包耗时极长，也是开发期卡顿的主要原因。
3. **分发体积冗余**：包含了大量对于桌面端无用的多余文件（如类型定义 `.d.ts`、测试文件、SourceMap、跨平台无用二进制等）。

---

## 2. 优化方案体系

### 方案 A：Bundler（esbuild / ncc）单文件打包 + 代码转换插件 (推荐中短期实施)

将 DSH 的 Node 端逻辑通过 Bundler 编译打包，将硬补丁转化为编译期 AST / 正则替换插件：

```
[DSH Entry] ───► [esbuild bundle] ───► [esbuild plugins (执行原 patch 逻辑)] ───► [bundle.mjs (单文件)]
```

#### 实现核心配置（示例）：
```javascript
// scripts/bundle-harness.mjs
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['staging/node_modules/@deepseek-ai/dsh-server/dist/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'src-tauri/resources/harness/bundle.mjs',
  external: [
    // 将含有原生 C++ 绑定 (.node) 的模块排除在外
    'better-sqlite3',
    'fsevents'
  ],
  plugins: [
    {
      name: 'dsh-desktop-patch-transformer',
      setup(build) {
        // 将原 patch-package 中的硬替换用代码变换钩子表达
        build.onLoad({ filter: /@deepseek-ai\/dsh-client-ui/ }, async (args) => {
          let contents = await readFile(args.path, 'utf8');
          // 注入 desktop 特性支持
          contents = contents.replace('/* target */', '/* patched */');
          return { contents, loader: 'js' };
        });
      }
    }
  ]
});
```

* **成效**：文件数量从 `10,000+` 减少到 `< 10` 个，解压组装时间由 2 分钟缩短至 5 秒。

---

### 方案 B：运行时 Monkey-Patch / ESM Loader 注入 (彻底告别构建期 Patch)

利用 Node 20+ 的 `import.meta.resolve` 或 `--import` / ESM Loader 特性，在 `harness-node-entry.mjs` 加载阶段拦截并动态修补：

1. **子进程拦截**：已实现的 `windows-child-process-hide.mjs` 即为此模式的典范，在 `child_process.spawn` 执行前动态包装 `windowsHide: true`。
2. **Cordis / DSH 插件注册**：通过 `build/dsh-desktop.patch.yml` 声明扩展插件，由 DSH 核心的服务发现机制按需动态载入 `dsh-desktop-client-ui` 等模块，无需对 DSH 核心源码作侵入式修改。

---

### 方案 C：Node SEA (Single Executable Applications) 独立二进制 (长期方案)

Node 20+ 原生支持将 JS 脚本直接打入 Node 二进制中：

1. 编写 SEA 配置文件：
   ```json
   {
     "main": "src-tauri/resources/harness/bundle.mjs",
     "output": "sea-prep.blob",
     "disableExperimentalSEAWarning": true
   }
   ```
2. 生成注入 blob 并与 `node.exe` 合并生成 `dsh-harness-core.exe`：
   ```bash
   node --experimental-sea-config sea-config.json
   # Windows 使用 postject 或 copy /b 组装为单个独立的 externalBin
   ```
3. **收益**：Tauri 直接通过 `externalBin` (Sidecar) 机制拉起单二进制进程，完全免除 `resources/` 下庞大的目录映射。

---

## 3. 落地推进指南

1. **Step 1**：优先将通用补丁通过 `harness-node-entry.mjs` 和 `dsh-desktop.patch.yml` 转移至运行时扩展；
2. **Step 2**：在 `scripts/prepare-harness.mjs` 中接入 esbuild 预打包步骤，缩减 node_modules 目录结构；
3. **Step 3**：验证 CLI 与 Tauri 端在 Single Bundle 模式下的各项指标（启动延时、Token 抓取、日志轮转）。
