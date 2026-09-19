#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 页面截图工具（光栅化验证 UI，不依赖 playwright）
 *
 * 原理：调用本机已装好的 Chrome / Edge 无头模式，用 CDP 驱动。
 * 好处是能执行一段 JS 再截图 —— 比如点开一张卡片、切到收藏视角，
 * 把「点完之后长什么样」也拍下来，而不是只拍首屏。
 *
 * 用法：
 *   node tools/shot.mjs --out shot.png [--url http://127.0.0.1:3000/]
 *                       [--w 1280] [--h 800] [--scale 1]
 *                       [--script "document.querySelector('.card').click()"]
 *                       [--script-file tools/probe.js]   ← 脚本较长时用这个，免去 shell 引号地狱
 *                       [--wait 4000] [--full]
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/* ── 参数 ─────────────────────────────────────────────── */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const URL_ = arg('url', 'http://127.0.0.1:3000/')
const OUT = arg('out', 'design/preview/shot.png')
const W = Number(arg('w', 1280))
const H = Number(arg('h', 820))
const SCALE = Number(arg('scale', 1))
const WAIT = Number(arg('wait', 4000))
const SCRIPT_FILE = arg('script-file', '')
const SCRIPT = SCRIPT_FILE ? fs.readFileSync(SCRIPT_FILE, 'utf8') : arg('script', '')
const FULL = flag('full')
const PORT = Number(arg('port', 9333))

/* ── 找浏览器 ─────────────────────────────────────────── */

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
]

function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* 继续找 */ }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── CDP 极简客户端 ───────────────────────────────────── */

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
  })

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })

  return { ready, send, close: () => ws.close() }
}

async function targets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('浏览器调试端口未就绪')
}

/* ── 主流程 ───────────────────────────────────────────── */

async function main() {
  const bin = findBrowser()
  if (!bin) throw new Error('本机没找到 Chrome / Edge')

  const profile = path.resolve('.tmp-shot-profile')
  const outPath = path.resolve(OUT)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    URL_
  ], { stdio: 'ignore' })

  let client = null
  try {
    const page = await targets()
    client = cdp(page.webSocketDebuggerUrl)
    await client.ready
    await client.send('Page.enable')

    // 页面可能还在首次加载，等它稳定
    await sleep(Math.min(WAIT, 3000))

    if (SCRIPT) {
      // 远程页面首次加载 / 自身跳转会把执行上下文顶掉，重试几次
      let r = null
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          r = await client.send('Runtime.evaluate', {
            expression: SCRIPT,
            awaitPromise: true,
            returnByValue: true
          })
          break
        } catch (err) {
          if (!/context was destroyed|Cannot find context/i.test(err.message)) throw err
          await sleep(1200)
        }
      }
      if (!r) throw new Error('页面反复重载，脚本没能执行')
      if (r.exceptionDetails) {
        throw new Error('脚本执行出错：' + r.exceptionDetails.text)
      }
      if (r.result && 'value' in r.result && r.result.value !== undefined) {
        console.log('script ->', JSON.stringify(r.result.value))
      }
    }

    await sleep(WAIT)

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: FULL
    })
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    console.log(`${outPath} （${fs.statSync(outPath).size} 字节）`)
  } finally {
    try { client && client.close() } catch { /* 忽略 */ }
    try { child.kill() } catch { /* 忽略 */ }
    await sleep(400)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

main().catch((err) => {
  console.error('截图失败：', err && err.message ? err.message : err)
  process.exitCode = 1
})
