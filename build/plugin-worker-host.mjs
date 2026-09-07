import readline from 'node:readline'

/**
 * DSH Desktop - Plugin Worker Host (Out-of-Process Sandbox)
 * 基于 JSON-RPC 2.0 协议的标准 stdio 插件运行沙盒
 */

const toolsRegistry = new Map()
const pluginsLoaded = new Set()

// 1. 发送标准 JSON-RPC 响应
function sendResponse(id, result = null, error = null) {
  const payload = {
    jsonrpc: '2.0',
    id,
    ...(error ? { error } : { result }),
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

// 2. 发送单向通知 (Notification)
function sendNotification(method, params = {}) {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

// 3. 处理请求分发
async function handleRequest(request) {
  const { id, method, params } = request

  try {
    switch (method) {
      case 'ping':
        sendResponse(id, { pong: true, timestamp: Date.now() })
        break

      case 'initialize': {
        sendResponse(id, {
          status: 'ready',
          version: '1.0.0',
          capabilities: { tools: true, mcp: true },
        })
        break
      }

      case 'tools/list': {
        const list = Array.from(toolsRegistry.values()).map((t) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object' },
        }))
        sendResponse(id, { tools: list })
        break
      }

      case 'tools/register': {
        const { name, description, inputSchema } = params || {}
        if (!name) {
          sendResponse(id, null, { code: -32602, message: 'Missing tool name' })
          return
        }
        toolsRegistry.set(name, { name, description, inputSchema })
        sendResponse(id, { registered: true, name })
        break
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {}
        const tool = toolsRegistry.get(name)
        if (!tool) {
          sendResponse(id, null, {
            code: -32601,
            message: `Tool not found in worker: ${name}`,
          })
          return
        }

        // 如果注册了 handler 则执行，否则返回模拟结果
        let output = null
        if (typeof tool.handler === 'function') {
          output = await tool.handler(args)
        } else {
          output = { message: `Tool ${name} executed successfully in sandbox` }
        }

        sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(output) }] })
        break
      }

      default:
        sendResponse(id, null, {
          code: -32601,
          message: `Method not found: ${method}`,
        })
    }
  } catch (err) {
    sendResponse(id, null, {
      code: -32000,
      message: err?.message || String(err),
      data: { stack: err?.stack },
    })
  }
}

// 4. 监听 stdio 消息
export function startPluginWorker() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const msg = JSON.parse(trimmed)
      if (msg.method) {
        handleRequest(msg)
      }
    } catch (e) {
      sendResponse(null, null, { code: -32700, message: 'Parse error: invalid JSON' })
    }
  })

  process.on('uncaughtException', (err) => {
    process.stderr.write(`[plugin-worker-fault] uncaught: ${err?.stack || err}\n`)
    sendNotification('worker/fault', { error: err?.message || String(err) })
  })

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[plugin-worker-fault] unhandled rejection: ${reason?.stack || reason}\n`)
    sendNotification('worker/fault', { error: String(reason) })
  })

  // 发送就绪通知
  sendNotification('worker/ready', { pid: process.pid })
}

// 直接运行判断
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('plugin-worker-host.mjs')) {
  startPluginWorker()
}
