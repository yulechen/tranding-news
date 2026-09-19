#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 内容推送工具
 *
 * 把本机生成好的 HTML 推进云端信息库。两种模式：
 *
 *   默认（直接入库）
 *     node tools/push.mjs --file report.html --title "美股盘前快报"
 *     —— 用云 SDK 直接写 documents 表，内容立刻出现在页面上，无需人工操作
 *
 *   --inbox（先暂存到收件箱）
 *     node tools/push.mjs --file report.html --title "标题" --inbox
 *     —— 先放到站点的 /api/inbox，之后在页面上点「归档」再入库
 *
 * 其他可选参数：
 *   --summary <s>   一句话摘要
 *   --type <s>      内容类型：report / dashboard / tool / page / other
 *   --base <url>    目标站点，默认线上地址；本地调试传 http://127.0.0.1:3000
 *   --stdin         从标准输入读取 HTML
 *   --dry           只打印，不发送
 *
 * ⚠️ 推送不设置标签 —— 标签由用户自己在页面上维护。
 *    原因：机器按标题临时拆出来的词几乎都是一次性的，很短时间就把标签区堆成几十个
 *    互不相干的碎片（实测 21 个标签里 19 个只出现过一次），筛选反而更难用。
 *    `--tags` 参数保留但会被忽略，只是为了让旧脚本和定时任务不至于报错。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DEFAULT_BASE = 'https://info-vault.app.workbuddy.host'
const INGEST_KEY = process.env.INGEST_KEY || 'iv_ing_7f3a9c2e5b8d4160a1f6e9c4b7d20385'
const MAX_CONTENT = 2 * 1024 * 1024
const TYPE_KEYS = ['report', 'dashboard', 'tool', 'page', 'other']

const SDK_FILE = path.join(ROOT, 'public', 'vendor', 'workbuddy-cloud-sdk.js')
const CONFIG_FILE = path.join(ROOT, 'public', 'config.js')

/* ── 参数解析 ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { tags: [], tagsIgnored: false }
  const flags = new Set(['stdin', 'dry', 'help', 'inbox'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (flags.has(key)) {
      out[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) continue
    i += 1
    if (key === 'tags') {
      // 标签不由推送方设置，这里只记录一下，好给用户一句提示
      out.tagsIgnored = value.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
    } else {
      out[key] = value
    }
  }
  return out
}

function usage() {
  console.log(`
云端信息库 · 内容推送工具

  node tools/push.mjs --file <路径> --title "标题" [--summary "摘要"] [--type report]
  node tools/push.mjs --file <路径> --title "标题" --inbox      # 改为暂存到收件箱
  cat x.html | node tools/push.mjs --stdin --title "标题"

参数：
  --file <path>   要推送的 HTML 文件
  --stdin         从标准输入读取 HTML
  --title <s>     标题（缺省时取文件名或 <title>）
  --summary <s>   一句话摘要
  --type <s>      内容类型：${TYPE_KEYS.join(' / ')}
  --inbox         走收件箱暂存（默认是直接入库）
  --base <url>    目标站点，默认 ${DEFAULT_BASE}
  --dry           只打印，不发送

注意：推送不设置标签。标签由你在页面卡片上手动维护，
      机器临时拆出来的标签会很快把标签区堆乱。
`)
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function guessTitle(filePath, html) {
  if (filePath) {
    const base = path.basename(filePath).replace(/\.html?$/i, '')
    if (base && !/^(index|main|app)$/i.test(base)) return base
  }
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (m && m[1].trim()) return m[1].trim().slice(0, 120)
  return '未命名内容'
}

/* ── 云 SDK 加载（Node 环境） ─────────────────────────────── */

function loadCloudSdk() {
  const code = fs.readFileSync(SDK_FILE, 'utf8')
  const sandbox = {
    console,
    fetch,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    AbortController,
    Headers,
    Request,
    Response,
    Blob,
    FormData,
    atob,
    btoa,
    navigator: { userAgent: 'node' },
    location: { href: DEFAULT_BASE + '/' }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return sandbox.WorkBuddyCloud
}

function readPublicConfig(base) {
  const src = fs.readFileSync(CONFIG_FILE, 'utf8')
  const endpoint = (src.match(/endpoint:\s*'([^']+)'/) || [])[1]
  const publishableKey = (src.match(/publishableKey:\s*'([^']+)'/) || [])[1]
  if (!endpoint || !publishableKey) throw new Error('读不到 public/config.js 里的云服务配置')
  return { endpoint: base || endpoint, publishableKey }
}

/* ── 直接入库 ─────────────────────────────────────────────── */

async function publishDirect(payload, base) {
  const cfg = readPublicConfig(base)
  const WBC = loadCloudSdk()
  const cloud = WBC.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    publishableKey: cfg.publishableKey
  })

  const size = Buffer.byteLength(payload.html, 'utf8')
  const row = {
    title: String(payload.title).slice(0, 200),
    summary: String(payload.summary || '').slice(0, 500),
    tags: [],                                  // 标签只由用户在页面上维护
    doc_type: TYPE_KEYS.includes(payload.docType) ? payload.docType : 'other',
    source: payload.source || 'workbuddy',
    content: payload.html,
    file_size: size
  }

  const res = await cloud.database.from('documents').insert(row).select('id,title')
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error))
  if (!Array.isArray(res.data) || !res.data.length) throw new Error('云端没有返回记录')
  return res.data[0]
}

/* ── 走收件箱暂存 ─────────────────────────────────────────── */

async function publishToInbox(payload, base) {
  const res = await fetch(`${base}/api/inbox`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-ingest-key': INGEST_KEY
    },
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/* ── 主流程 ───────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  let html = ''
  if (args.stdin) {
    html = await readStdin()
  } else if (args.file) {
    const abs = path.resolve(args.file)
    if (!fs.existsSync(abs)) {
      console.error(`找不到文件：${abs}`)
      process.exitCode = 1
      return
    }
    html = fs.readFileSync(abs, 'utf8')
  } else {
    usage()
    process.exitCode = 1
    return
  }

  if (!html.trim()) {
    console.error('内容为空，已中止。')
    process.exitCode = 1
    return
  }

  const base = (args.base || DEFAULT_BASE).replace(/\/+$/, '')
  const payload = {
    title: args.title || guessTitle(args.file, html),
    summary: args.summary || '',
    tags: [],                                  // 见文件头说明：推送不设置标签
    docType: args.type || 'report',
    source: args.source || 'workbuddy',
    html
  }

  const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  const mode = args.inbox ? '收件箱暂存' : '直接入库'
  console.log(`→ 目标：${base}`)
  console.log(`  模式：${mode}`)
  console.log(`  标题：${payload.title}`)
  console.log(`  大小：${sizeKb} KB`)
  console.log('  标签：不设置（标签由你在页面上自己维护）')

  if (args.tagsIgnored.length) {
    console.log(`  ⚠️ 已忽略 --tags：${args.tagsIgnored.join(' / ')}`)
  }

  if (args.dry) {
    console.log('（--dry 模式，未发送）')
    return
  }

  try {
    if (args.inbox) {
      const data = await publishToInbox(payload, base)
      console.log(`✓ 已送入收件箱（id=${data.id}）。打开云端信息库点「全部归档」即可入库。`)
    } else {
      const row = await publishDirect(payload, base)
      console.log(`✓ 已入库（id=${row.id}）。打开 ${base}/ 就能看到。`)
    }
  } catch (err) {
    console.error(`推送失败：${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}

main()
