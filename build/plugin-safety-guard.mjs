import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'

/**
 * 插件注册防护与故障归因
 *
 * ⚠️ 状态（2026-09-10）：**部分接线**。
 * - ✅ `formatFaultDetails` —— 已接线：由 `harness-node-entry.mjs` 的
 *   `uncaughtException` / `unhandledRejection` 处理器消费，产出
 *   `[dsh-plugin-fault]` 结构化标识。
 * - ❌ `PluginWorkerClient` —— **未接线（experimental）**：无任何调用方。
 *   它可按需 spawn `plugin-worker-host.mjs` 建立进程外 JSON-RPC 通道，但插件
 *   隔离不在真实插件挂载路径上（真实挂载走 Harness 进程内的官方 Cordis 体系），
 *   启用它会凭空引入常驻子进程。启用前须先一并接通 Rust 侧
 *   `dsh_host::plugin_worker::PluginIsolationManager`，并更新
 *   `docs/plugin_isolation_architecture.md` 的状态说明。
 * - 因此本文件**不会**主动输出 `[dsh-worker-fault]`：该标识只在
 *   `PluginWorkerClient` 被使用时才可能产生。
 */

export function installPluginSafetyGuards() {
  // 1. 结构化错误诊断提取
  function formatFaultDetails(error) {
    const message = error?.message || String(error)

    const toolMatch =
      message.match(/tool\s+["']?([^"'\s]+)["']?\s+already\s+registered/i) ||
      message.match(/duplicate\s+tool\s+["']?([^"'\s]+)["']?/i)
    if (toolMatch) {
      return `duplicate tool registration: ${toolMatch[1]}`
    }

    const routeMatch =
      message.match(/route\s+["']?([^"'\s]+)["']?\s+already\s+registered/i) ||
      message.match(/route\s+["']?([^"'\s]+)["']?\s+already\s+exists/i)
    if (routeMatch) {
      return `duplicate route registration: ${routeMatch[1]}`
    }

    const loaderMatch = message.match(/failed to apply loader entry [^(]*\(([^)]+)\)/i)
    if (loaderMatch) {
      return `loader failure in plugin: ${loaderMatch[1]}`
    }

    return null
  }

  // 2. 插件 Worker 客户端代理类 (Out-of-process client)
  //    ⚠️ 未接线：见文件顶部状态说明。保留实现以待接线，勿在无消费方时启用。
  class PluginWorkerClient {
    constructor() {
      this.child = null
      this.requestId = 0
      this.pendingRequests = new Map()
      this.isReady = false
      this.registeredTools = new Map()
    }

    start() {
      if (this.child) return

      const currentDir = path.dirname(fileURLToPath(import.meta.url))
      const workerScript = path.join(currentDir, 'plugin-worker-host.mjs')

      this.child = spawn(process.execPath, [workerScript], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, DSH_WORKER_MODE: 'isolated' },
      })

      const rl = readline.createInterface({
        input: this.child.stdout,
        terminal: false,
      })

      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line.trim())
          if (msg.method === 'worker/ready') {
            this.isReady = true
            return
          }
          if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id)
            this.pendingRequests.delete(msg.id)
            if (msg.error) {
              reject(new Error(msg.error.message || 'Worker RPC error'))
            } else {
              resolve(msg.result)
            }
          }
        } catch {
          // ignore non-json
        }
      })

      this.child.on('error', (err) => {
        process.stderr.write(`[dsh-worker-fault] process error: ${err.message}\n`)
      })

      this.child.on('exit', (code) => {
        process.stderr.write(`[dsh-worker-fault] worker exited with code ${code}\n`)
        this.child = null
        this.isReady = false
      })
    }

    sendRequest(method, params = {}, timeoutMs = 30000) {
      this.start()
      return new Promise((resolve, reject) => {
        const id = ++this.requestId
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id)
          reject(new Error(`Worker RPC timeout for method ${method}`))
        }, timeoutMs)

        this.pendingRequests.set(id, {
          resolve: (val) => {
            clearTimeout(timer)
            resolve(val)
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          },
        })

        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        this.child.stdin.write(payload)
      })
    }

    async registerToolProxy(name, description, inputSchema) {
      this.registeredTools.set(name, { name, description, inputSchema })
      return this.sendRequest('tools/register', { name, description, inputSchema })
    }

    async callTool(name, args) {
      return this.sendRequest('tools/call', { name, arguments: args })
    }

    stop() {
      if (this.child) {
        this.child.kill()
        this.child = null
      }
    }
  }

  const workerClient = new PluginWorkerClient()

  return {
    formatFaultDetails,
    workerClient,
  }
}
