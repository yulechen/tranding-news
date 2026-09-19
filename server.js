'use strict'

/**
 * 云端信息库 · 站点服务
 *
 * 两个职责：
 *   1. 托管前端静态资源（public/）
 *   2. 提供「Agent 收件箱」通道（/api/inbox）
 *      —— WorkBuddy 在本机生成 HTML 后，直接 POST 到这里暂存；
 *         用户在浏览器里登录后，一键把它归档进云端存储 + 云数据库。
 *
 * 零第三方依赖，只用 Node 内置模块。
 */

const http = require('http')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 3000)
const HOST = '0.0.0.0'
const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const INBOX_DIR = path.join(ROOT, 'inbox')

// 收件箱写入密钥。tools/push.mjs 用同一个值。
// 可用环境变量覆盖，方便本地调试。
const INGEST_KEY = process.env.INGEST_KEY || 'iv_ing_7f3a9c2e5b8d4160a1f6e9c4b7d20385'

const MAX_BODY = 2 * 1024 * 1024 // 单个内容上限 2MB
const INBOX_TTL_MS = 14 * 24 * 3600 * 1000 // 收件箱条目保留 14 天

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('内容太大了'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 把 URL 路径安全地解析到 public/ 之下，挡住 ../ 穿越 */
function resolvePublic(pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const full = path.normalize(path.join(PUBLIC_DIR, rel))
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null
  return full
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)
}

async function ensureInbox() {
  await fsp.mkdir(INBOX_DIR, { recursive: true })
}

/* ------------------------------------------------------------------ */
/* 收件箱                                                              */
/* ------------------------------------------------------------------ */

async function listInbox() {
  await ensureInbox()
  let names = []
  try {
    names = await fsp.readdir(INBOX_DIR)
  } catch {
    return []
  }

  const now = Date.now()
  const items = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const metaPath = path.join(INBOX_DIR, name)
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
      const age = now - Number(meta.receivedAt || 0)
      if (!Number.isFinite(age) || age > INBOX_TTL_MS) {
        await removeInboxItem(meta.id).catch(() => {})
        continue
      }
      items.push({
        id: meta.id,
        title: meta.title || '未命名',
        summary: meta.summary || '',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        docType: meta.docType || 'report',
        source: meta.source || 'workbuddy',
        size: Number(meta.size || 0),
        receivedAt: Number(meta.receivedAt || 0)
      })
    } catch {
      // 损坏的条目直接忽略，不影响整体列表
    }
  }

  items.sort((a, b) => b.receivedAt - a.receivedAt)
  return items
}

async function readInboxItem(id) {
  if (!isSafeId(id)) return null
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(INBOX_DIR, `${id}.json`), 'utf8'))
    const html = await fsp.readFile(path.join(INBOX_DIR, `${id}.html`), 'utf8')
    return { meta, html }
  } catch {
    return null
  }
}

async function removeInboxItem(id) {
  if (!isSafeId(id)) return false
  let removed = false
  for (const ext of ['.json', '.html']) {
    try {
      await fsp.unlink(path.join(INBOX_DIR, `${id}${ext}`))
      removed = true
    } catch {
      /* 不存在就跳过 */
    }
  }
  return removed
}

async function clearInbox() {
  const items = await listInbox()
  let removed = 0
  for (const it of items) {
    if (await removeInboxItem(it.id)) removed += 1
  }
  return removed
}

async function putInboxItem(payload) {
  await ensureInbox()

  const html = typeof payload.html === 'string' ? payload.html : ''
  if (!html.trim()) {
    throw Object.assign(new Error('html 内容为空'), { status: 400 })
  }

  const size = Buffer.byteLength(html, 'utf8')
  if (size > MAX_BODY) {
    throw Object.assign(new Error('内容超过 2MB 上限'), { status: 413 })
  }

  const id = crypto.randomUUID().replace(/-/g, '')
  const receivedAt = Date.now()

  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : String(payload.tags || '')
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12)

  const meta = {
    id,
    title: String(payload.title || '未命名内容').slice(0, 200),
    summary: String(payload.summary || '').slice(0, 500),
    tags,
    docType: String(payload.docType || 'report').slice(0, 40),
    source: String(payload.source || 'workbuddy').slice(0, 40),
    size,
    receivedAt
  }

  // 先写正文，再写元数据 —— 元数据存在即代表条目完整
  await fsp.writeFile(path.join(INBOX_DIR, `${id}.html`), html, 'utf8')
  await fsp.writeFile(path.join(INBOX_DIR, `${id}.json`), JSON.stringify(meta), 'utf8')

  return meta
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function keyOf(req, url) {
  return req.headers['x-ingest-key'] || url.searchParams.get('key') || ''
}

function keyOk(req, url) {
  const provided = String(keyOf(req, url))
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(INGEST_KEY)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

async function handleInboxApi(req, res, url, segments) {
  if (!keyOk(req, url)) {
    return sendJson(res, 401, { ok: false, error: '密钥不正确' })
  }

  // /api/inbox
  if (segments.length === 0) {
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, { ok: true, items: await listInbox() })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: '读取收件箱失败' })
      }
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req, MAX_BODY + 1024)
        let payload
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
        }
        const meta = await putInboxItem(payload)
        return sendJson(res, 200, { ok: true, id: meta.id, size: meta.size })
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || '写入失败' })
      }
    }
    if (req.method === 'DELETE') {
      const removed = await clearInbox()
      return sendJson(res, 200, { ok: true, removed })
    }
    return sendJson(res, 405, { ok: false, error: '方法不支持' })
  }

  // /api/inbox/:id
  const id = segments[0]
  if (segments.length !== 1) {
    return sendJson(res, 404, { ok: false, error: '路径不存在' })
  }

  if (req.method === 'GET') {
    const found = await readInboxItem(id)
    if (!found) return sendJson(res, 404, { ok: false, error: '条目不存在' })
    return sendJson(res, 200, { ok: true, meta: found.meta, html: found.html })
  }

  if (req.method === 'DELETE') {
    const removed = await removeInboxItem(id)
    return sendJson(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '条目不存在' })
  }

  return sendJson(res, 405, { ok: false, error: '方法不支持' })
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed')
  }

  const filePath = resolvePublic(pathname)
  if (!filePath) return sendText(res, 400, 'Bad Request')

  try {
    const stat = await fsp.stat(filePath)
    if (stat.isDirectory()) return sendText(res, 404, 'Not Found')

    const data = await fsp.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      // 每次回源校验，保证发布新版本后立刻生效
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') return res.end()
    res.end(data)
  } catch {
    return sendText(res, 404, 'Not Found')
  }
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    return sendText(res, 400, 'Bad Request')
  }

  const pathname = url.pathname

  // 注意：/healthz 被平台网关占用，返回的是平台自己的探针响应，所以用 /api/health
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'info-vault', ts: Date.now() })
  }

  if (pathname === '/api/inbox' || pathname.startsWith('/api/inbox/')) {
    const rest = pathname.slice('/api/inbox'.length).replace(/^\/+|\/+$/g, '')
    const segments = rest ? rest.split('/') : []
    try {
      return await handleInboxApi(req, res, url, segments)
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: '服务内部错误' })
    }
  }

  return handleStatic(req, res, pathname)
})

server.listen(PORT, HOST, async () => {
  await ensureInbox().catch(() => {})
  console.log(`云端信息库 · 服务已启动 http://${HOST}:${PORT}`)
})

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err)
})
