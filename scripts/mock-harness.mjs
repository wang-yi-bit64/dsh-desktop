#!/usr/bin/env node
/**
 * mock-harness.mjs — 契约对齐的 Harness 替身（任务 0.4，ADR-2）。
 *
 * 存在的意义：让 Tauri 层与 dsh-host 的日常迭代**不需要** 300MB 的真实
 * 依赖树，且能在 CI 上稳定复现各种失败路径。
 *
 * 对齐的契约：
 *   C1  接受 `web --patch <yml> --no-open --host 127.0.0.1 --port <n>`
 *      （真实调用还会在前面加 `--expose-internals <entry> <bin.js>`，
 *       本脚本忽略这两个位置参数）
 *   C3  stdout 打印 `${prefix}dsh web: http://127.0.0.1:<port>/?token=<uuid>`
 *   C4  `GET /` 返回 401（无 token 属正常）；健康区间 200≤status<500
 *   C5  仅 `GET /?token=` 返回 200 并下发 `dsh-auth-*` cookie
 *
 * 用法：
 *   node scripts/mock-harness.mjs web --port 4173 --delay 800 --fail <mode>
 *
 * 故障模式（也可用环境变量注入，便于 `DSH_MOCK=1 cargo tauri dev`）：
 *   startup       启动即退出（exit 3）
 *   no-url        卡住不打印 URL（触发就绪超时）
 *   probe-500     探测一律返回 500（永不健康）
 *   after-ready   打印 URL 后 5s 崩溃（验证 exit watcher → 错误页）
 *   port-in-use   stderr 打印 EADDRINUSE 后退出（验证快速失败 + 换端口重试）
 *
 * 环境变量：
 *   DSH_MOCK_DELAY / DSH_MOCK_FAIL / DSH_MOCK_PORT
 *   DSH_MOCK_AFTER_READY_MS    after-ready 崩溃延迟（默认 5000ms，测试可压短）
 *   DSH_MOCK_PORT_IN_USE_MS    port-in-use 打印 EADDRINUSE 后的存活时长
 *                              （默认 500ms，保证宿主日志泵稳定观察到该行，
 *                              避免「打印后立即退出」被竞态误判成 ProcessExited）
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)

function readOption(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

const port = Number(readOption('--port', process.env.DSH_MOCK_PORT ?? '0'))
const delay = Number(readOption('--delay', process.env.DSH_MOCK_DELAY ?? '800'))
const fail = readOption('--fail', process.env.DSH_MOCK_FAIL ?? '')

const HOST = '127.0.0.1'

/** C3 之外的诊断行：真实入口会打印，日志解析必须能容忍。 */
function diagnostics() {
  console.log(
    `[arness-node] runtime node=${process.version} platform=${process.platform} arch=${process.arch}`
  )
  console.log(`[arness-node] cwd=${process.cwd()}`)
  // T05：把真实 argv 提前打到 diagnostics，排障 / 集成测试能直接核对
  // 「宿主到底传了什么」。
  console.log(`[harness-node] argv=${JSON.stringify(args)}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function page(token) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH Mock</title></head>
<body style="font:14px/1.6 system-ui;padding:24px">
  <h1>Mock Harness</h1>
  <p>token 已兑换为会话 cookie：<code>${token}</code></p>
  <p>端口：<code>${port}</code>，故障模式：<code>${fail || 'none'}</code></p>
</body></html>`
}

function startServer(token, listenPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${HOST}:${listenPort}`)
      const supplied = url.searchParams.get('token')

      if (fail === 'probe-500') {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('mock: forced 500')
        return
      }

      // C5：只有带上启动 token 的首航才换 cookie。
      if (supplied && supplied === token) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `dsh-auth-session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
        })
        res.end(page(token))
        return
      }

      // C4：未带 token 的 GET / 返回 401，属「服务已起」的正常状态。
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('mock: token required')
    })

    server.on('error', reject)
    server.listen(listenPort, HOST, () => resolve(server))
  })
}

async function main() {
  if (fail === 'startup') {
    console.error('DSH entry failed: mock startup failure')
    process.exit(3)
  }

  if (fail === 'port-in-use') {
    console.error(
      `Error: listen EADDRINUSE: address already in use ${HOST}:${port || 4173}`
    )
    // 打印 EADDRINUSE 后**保持存活一小段**再退出：让宿主的日志泵稳定观察到
    // 该行，从而走「换端口重试」而非被竞态误判成 ProcessExited。
    const keepalive = Number(process.env.DSH_MOCK_PORT_IN_USE_MS ?? '500')
    await sleep(keepalive)
    process.exit(9)
  }

  diagnostics()

  if (fail === 'no-url') {
    // 卡住：既不打印 URL 也不退出，用于验证就绪总超时。
    setInterval(() => {}, 1 << 30)
    return
  }

  const token = randomUUID()
  const server = await startServer(token, port)
  const actualPort = server.address().port

  await sleep(delay)

  // C3：正则 `\bdsh web:\s*(\S+)` 的匹配目标。
  console.log(`dsh web: http://${HOST}:${actualPort}/?token=${token}`)

  if (fail === 'after-ready') {
    const crashDelay = Number(process.env.DSH_MOCK_AFTER_READY_MS ?? '5000')
    setTimeout(() => {
      console.error('uncaught exception: mock crash after ready')
      process.exit(7)
    }, crashDelay)
  }
}

main().catch((error) => {
  console.error(`DSH entry failed: ${error?.message ?? error}`)
  process.exit(1)
})
