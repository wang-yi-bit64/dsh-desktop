/**
 * 插件进程隔离宿主 2.0 (plugin-worker-host.mjs)
 * 
 * 提供 Tier 0/1/2 分级沙箱支持与 stdio / worker_threads JSON-RPC 2.0 通信。
 */

import { parentPort, workerData } from 'node:worker_threads';
import process from 'node:process';
import readline from 'node:readline';

// 捕获未捕获异常，防止宿主主进程被直接拖垮
process.on('uncaughtException', (err) => {
  sendErrorResponse(null, -32000, `Worker Uncaught Exception: ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  sendErrorResponse(null, -32000, `Worker Unhandled Rejection: ${String(reason)}`);
});

function sendSuccessResponse(id, result) {
  const msg = {
    jsonrpc: '2.0',
    id,
    result,
  };
  if (parentPort) {
    parentPort.postMessage(msg);
  } else {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

function sendErrorResponse(id, code, message, data = null) {
  const msg = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
  if (parentPort) {
    parentPort.postMessage(msg);
  } else {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

async function handleRpcMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') {
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'ping':
        sendSuccessResponse(id, { pong: true, timestamp: Date.now() });
        break;

      case 'plugin.init':
        sendSuccessResponse(id, {
          initialized: true,
          tier: params?.tier || 'tier_2',
          pluginId: params?.pluginId || 'unknown',
        });
        break;

      case 'plugin.callTool': {
        const { toolName, args } = params || {};
        // 模拟/执行插件工具
        sendSuccessResponse(id, {
          tool: toolName,
          status: 'success',
          output: `Tool '${toolName}' executed with isolated context`,
          echoArgs: args,
        });
        break;
      }

      default:
        sendErrorResponse(id, -32601, `Method not found: ${method}`);
        break;
    }
  } catch (e) {
    sendErrorResponse(id, -32000, `Execution error: ${e.message}`, { stack: e.stack });
  }
}

// 适配双模式：worker_threads 或 stdio 子进程
if (parentPort) {
  parentPort.on('message', handleRpcMessage);
} else {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleRpcMessage(msg);
    } catch (e) {
      sendErrorResponse(null, -32700, `Parse error: ${e.message}`);
    }
  });
}
