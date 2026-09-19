/* ═══════════════════════════════════════════════════════════
   云端信息库 · 前端逻辑
   无需登录，打开即看；内容正文直接存在云数据库里。
   内容的组织靠标签：每张卡片都能随手打标签，顶部按标签过滤。
   顶栏另有「接口」（推送数据的开放接口说明）与「留言」（留言板）。
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict'

  const CFG = window.APP_CONFIG || {}
  const INGEST_KEY = 'iv_ing_7f3a9c2e5b8d4160a1f6e9c4b7d20385'
  const MAX_CONTENT = 2 * 1024 * 1024       // 单个内容上限 2MB

  const LIST_FIELDS = 'id,title,summary,tags,doc_type,source,file_size,starred,created_at'

  /* 云数据库的裸 REST 端点（不涉及登录，用应用标识鉴权）。
     接口说明弹窗里的示例全部由它拼出来，避免文档和实际接口写岔。 */
  const REST_BASE = String(CFG.endpoint || '').replace(/\/+$/, '') + '/.cloud/database/rest'
  const API_URL = `${REST_BASE}/documents`

  const MSG_FIELDS = 'id,author,body,created_at'
  const MSG_MAX = 2000
  const AUTHOR_KEY = 'iv_msg_author'

  const TYPES = [
    { key: 'all', label: '全部' },
    { key: 'report', label: '报告' },
    { key: 'dashboard', label: '看板' },
    { key: 'tool', label: '工具' },
    { key: 'page', label: '页面' },
    { key: 'other', label: '其他' }
  ]
  const TYPE_LABEL = TYPES.reduce((m, t) => (m[t.key] = t.label, m), {})
  const TYPE_KEYS = TYPES.map((t) => t.key).filter((k) => k !== 'all')

  const STAR_PATH = 'M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.85z'
  const starSvg = (on) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`

  const TAG_PATH = 'M20.6 12.9l-7.7 7.7a1.5 1.5 0 01-2.1 0l-7.4-7.4a1.5 1.5 0 01-.44-1.06V5.5a1.5 1.5 0 011.5-1.5h6.6c.4 0 .78.16 1.06.44l7.5 7.5a1.5 1.5 0 010 2.06z'
  const tagSvg =
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TAG_PATH}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="8.5" cy="8.5" r="1.45" fill="currentColor"/></svg>`

  const $ = (sel) => document.querySelector(sel)

  const el = {
    boot: $('#boot'),
    mainView: $('#main-view'),

    btnRefresh: $('#btn-refresh'),
    btnApi: $('#btn-api'),
    btnMsg: $('#btn-msg'),
    msgBadge: $('#msg-badge'),

    inboxBar: $('#inbox-bar'),
    inboxCount: $('#inbox-count'),
    inboxHint: $('#inbox-hint'),
    btnArchiveAll: $('#btn-archive-all'),
    btnDismissInbox: $('#btn-dismiss-inbox'),

    typeChips: $('#type-chips'),
    statText: $('#stat-text'),
    sort: $('#sort'),
    tagRow: $('#tag-row'),
    grid: $('#doc-grid'),
    empty: $('#empty'),
    emptyTitle: $('#empty-title'),
    emptyDesc: $('#empty-desc'),

    preview: $('#preview'),
    previewBack: $('#preview-back'),
    previewTitle: $('#preview-title'),
    previewFrame: $('#preview-frame'),
    previewActions: document.querySelector('.preview-actions'),
    previewStar: $('#preview-star'),

    editModal: $('#edit-modal'),
    editTitle: $('#edit-title'),
    editSummary: $('#edit-summary'),
    editTags: $('#edit-tags'),
    editTagSuggest: $('#edit-tag-suggest'),
    editType: $('#edit-type'),
    editMsg: $('#edit-msg'),
    editConfirm: $('#edit-confirm'),
    editCancel: $('#edit-cancel'),
    editClose: $('#edit-close'),

    tagModal: $('#tag-modal'),
    tagDoc: $('#tag-doc'),
    tagInput: $('#tag-input'),
    tagCurrent: $('#tag-current'),
    tagPool: $('#tag-pool'),
    tagMsg: $('#tag-msg'),
    tagSave: $('#tag-save'),
    tagCancel: $('#tag-cancel'),
    tagClose: $('#tag-close'),

    apiModal: $('#api-modal'),
    apiBody: $('#api-body'),
    apiClose: $('#api-close'),
    apiOk: $('#api-ok'),
    apiCopy: $('#api-copy'),

    msgModal: $('#msg-modal'),
    msgList: $('#msg-list'),
    msgBody: $('#msg-body'),
    msgAuthor: $('#msg-author'),
    msgSend: $('#msg-send'),
    msgMsg: $('#msg-msg'),
    msgClose: $('#msg-close'),

    toast: $('#toast')
  }

  /* ── 状态 ─────────────────────────────────────────────── */
  let cloud = null
  let docs = []
  let inbox = []
  let messages = []
  let msgLoading = false
  let editing = null
  let tagEditing = null      // 正在编辑标签的内容
  let tagDraft = []          // 标签弹窗里的草稿（改完点保存才落库）
  let current = null
  let currentHtml = ''
  let loading = false

  const view = { type: 'all', tag: '', sort: 'new', starred: false }

  /* ── 通用工具 ─────────────────────────────────────────── */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function byteLength(s) {
    return new TextEncoder().encode(String(s)).length
  }

  const pad2 = (n) => String(n).padStart(2, '0')

  function fmtTime(input) {
    const d = new Date(input)
    if (isNaN(d.getTime())) return '—'
    const now = new Date()
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
    const y = new Date(now)
    y.setDate(now.getDate() - 1)
    if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  function fmtSize(n) {
    const v = Number(n || 0)
    if (!v) return '—'
    if (v < 1024) return `${v} B`
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
    return `${(v / 1024 / 1024).toFixed(1)} MB`
  }

  let toastTimer = null
  function toast(text, kind) {
    el.toast.textContent = text
    el.toast.className = 'toast is-on' + (kind ? ` is-${kind}` : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast'
    }, kind === 'err' ? 4600 : 2600)
  }

  function modalNote(node, text, kind) {
    node.textContent = text || ''
    node.className = 'modal-msg' + (kind ? ` is-${kind}` : '')
  }

  /** 把云端错误翻译成人话 */
  function friendly(err) {
    if (!err) return '操作失败'
    const code = String(err.code || '')
    const msg = err.message || String(err)
    const has = (c) => code.includes(c)
    if (has('42501')) return '没有写入权限：云端权限策略可能未生效'
    if (has('42P01')) return '数据表不存在，需要在云端先建表'
    if (has('23505')) return '这个内容已经存在了'
    if (has('23514')) return '内容不符合要求：不能为空，也不能超过字数上限'
    if (has('PGRST116')) return '找不到这条内容'
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return '网络不通，请检查连接后重试'
    return msg
  }

  function previewShell(inner) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%}
      body{display:grid;place-items:center;text-align:center;padding:24px;
        font:14px system-ui,-apple-system,"PingFang SC",sans-serif;color:#8a90a2}
      b{display:block;color:#4b5162;margin-bottom:8px;font-size:15px;font-weight:600}
    </style></head><body><div>${inner}</div></body></html>`
  }

  /* ── 标签：一律由用户自己维护，界面只负责引导「复用」 ── */

  /** 统计标签出现次数，次数降序，同次数按拼音 */
  function tagCounts(list) {
    const m = new Map()
    list.forEach((d) => (d.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)))
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }

  const splitTags = (v) =>
    String(v || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)

  /** 每条内容的标签上限，避免又堆成一片 */
  const MAX_TAGS = 12

  /** 在输入框下方列出已有标签，点一下追加 —— 防止同一个意思写成好几个词 */
  function renderTagSuggest(box, input) {
    if (!box || !input) return
    const used = new Set(splitTags(input.value))
    const tags = tagCounts(docs).map((e) => e[0]).filter((t) => !used.has(t)).slice(0, 12)
    if (!tags.length) {
      box.classList.add('is-hidden')
      box.innerHTML = ''
      return
    }
    box.classList.remove('is-hidden')
    box.innerHTML =
      '<span class="tag-suggest-label">已有标签</span>' +
      tags.map((t) => `<button type="button" data-suggest="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')
  }

  function addSuggestedTag(input, tag) {
    const list = splitTags(input.value)
    if (!list.includes(tag)) list.push(tag)
    input.value = list.join(', ')
    input.dispatchEvent(new Event('input'))
  }

  /** 选中的标签如果已经从库里消失了，就把它从筛选条件里摘掉，避免筛出空列表又退不出来 */
  function normalizeTagView() {
    if (view.tag && !docs.some((d) => Array.isArray(d.tags) && d.tags.includes(view.tag))) {
      view.tag = ''
    }
  }

  /* ── 云端客户端 ───────────────────────────────────────── */

  function initCloud() {
    const WC = window.WorkBuddyCloud
    if (!WC || typeof WC.createWorkBuddyCloud !== 'function') {
      throw new Error('云端 SDK 未能加载，检查网络后刷新页面')
    }
    if (!CFG.endpoint || !CFG.publishableKey) {
      throw new Error('缺少云端配置（config.js）')
    }
    return WC.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      publishableKey: CFG.publishableKey
    })
  }

  /* ═══════════════ 列表 ═══════════════ */

  async function loadDocs(showToast) {
    if (loading) return
    loading = true
    try {
      const { data, error } = await cloud.database
        .from('documents')
        .select(LIST_FIELDS)
        .order('created_at', { ascending: false })
        .limit(500)

      if (error) throw error
      docs = Array.isArray(data) ? data : []
      renderFilters()
      renderDocs()
      if (showToast) toast(`已刷新，共 ${docs.length} 个内容`, 'ok')
    } catch (err) {
      docs = []
      renderFilters()
      renderDocs(err)
      toast(friendly(err), 'err')
    } finally {
      loading = false
    }
  }

  function visibleDocs() {
    let list = docs.slice()

    if (view.type !== 'all') list = list.filter((d) => (d.doc_type || 'other') === view.type)
    if (view.tag) list = list.filter((d) => Array.isArray(d.tags) && d.tags.includes(view.tag))
    if (view.starred) list = list.filter((d) => !!d.starred)

    const byDate = (d) => new Date(d.created_at).getTime() || 0
    if (view.sort === 'new') list.sort((a, b) => byDate(b) - byDate(a))
    else if (view.sort === 'old') list.sort((a, b) => byDate(a) - byDate(b))
    else if (view.sort === 'title') {
      list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'))
    } else if (view.sort === 'size') {
      list.sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))
    }

    // 星标置顶
    list.sort((a, b) => Number(!!b.starred) - Number(!!a.starred))
    return list
  }

  function renderFilters() {
    normalizeTagView()

    // 分面计数：类型看「收藏 + 标签」之后的结果，标签看「收藏 + 类型」之后的结果。
    // 这样每个选项上的数字就是「点进去大概有几条」，不会点出一片空白。
    const afterStar = view.starred ? docs.filter((d) => !!d.starred) : docs
    const afterTag = view.tag
      ? afterStar.filter((d) => Array.isArray(d.tags) && d.tags.includes(view.tag))
      : afterStar
    const afterType = view.type !== 'all'
      ? afterStar.filter((d) => (d.doc_type || 'other') === view.type)
      : afterStar

    const starredN = docs.filter((d) => !!d.starred).length

    const counts = { all: afterTag.length }
    TYPE_KEYS.forEach((k) => {
      counts[k] = afterTag.filter((d) => (d.doc_type || 'other') === k).length
    })

    const starChip =
      `<button type="button" class="chip chip-star${view.starred ? ' is-active' : ''}" data-fav="1" title="只看收藏">` +
      starSvg(view.starred) +
      `<span>收藏</span><span class="chip-n">${starredN}</span></button>` +
      `<span class="chip-sep" aria-hidden="true"></span>`

    el.typeChips.innerHTML = starChip + TYPES.map((t) => {
      const n = counts[t.key] || 0
      if (t.key !== 'all' && n === 0) return ''
      return `<button type="button" class="chip${view.type === t.key ? ' is-active' : ''}" data-type="${t.key}">${t.label}<span class="chip-n">${n}</span></button>`
    }).join('')

    const tags = tagCounts(afterType).slice(0, 24)
    // 选中的标签即使被类型筛成 0 条也要留着，否则用户看不到自己正卡在哪个筛选上
    if (view.tag && !tags.some(([t]) => t === view.tag)) tags.unshift([view.tag, 0])

    if (!tags.length) {
      // 一条标签都还没有：留着这一行，告诉用户标签在哪打，否则功能等于藏起来了
      el.tagRow.classList.remove('is-hidden')
      el.tagRow.innerHTML =
        `<span class="tag-row-label">${tagSvg}标签</span>` +
        `<span class="tag-row-hint">还没有标签 —— 点卡片右上角的标签按钮，给内容归个类</span>`
    } else {
      el.tagRow.classList.remove('is-hidden')
      el.tagRow.innerHTML =
        `<span class="tag-row-label">${tagSvg}标签</span>` +
        `<button type="button" class="tag-pill${!view.tag ? ' is-active' : ''}" data-tag="">全部</button>` +
        tags.map(([t, n]) =>
          `<button type="button" class="tag-pill${view.tag === t ? ' is-active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)} · ${n}</button>`
        ).join('')
    }
  }

  function renderDocs(error) {
    const list = visibleDocs()
    el.statText.textContent = docs.length ? `共 ${list.length} / ${docs.length} 个内容` : ''

    if (!list.length) {
      el.grid.innerHTML = ''
      el.empty.classList.remove('is-hidden')
      if (error) {
        el.emptyTitle.textContent = '载入失败'
        el.emptyDesc.textContent = friendly(error)
        return
      }
      const filtering = view.type !== 'all' || view.tag
      if (view.starred) {
        el.emptyTitle.textContent = filtering ? '收藏里没有匹配的内容' : '收藏夹是空的'
        el.emptyDesc.textContent = filtering
          ? '换个标签，或点「全部」看看全部收藏。'
          : '点卡片右上角的星标，或打开内容后点「收藏」，收藏的东西会集中到这里，随时能快速翻出来。'
        return
      }
      el.emptyTitle.textContent = filtering ? '没有匹配的内容' : '还是空的'
      el.emptyDesc.textContent = filtering
        ? '换个标签，或点「全部」看看所有内容。'
        : 'WorkBuddy 推送过来的内容会出现在这里。给它们打上标签，以后就能按标签快速翻出来。'
      return
    }

    el.empty.classList.add('is-hidden')
    el.grid.innerHTML = list.map((d, i) => {
      const tags = (d.tags || []).slice(0, 4)
      const extra = (d.tags || []).length - tags.length
      const type = TYPE_LABEL[d.doc_type] ? d.doc_type : 'other'
      const delay = Math.min(i, 12) * 24
      const hasTags = (d.tags || []).length > 0
      return `<article class="card${d.starred ? ' is-starred' : ''}" data-id="${d.id}" style="animation-delay:${delay}ms">
        <div class="card-top">
          <span class="type-badge" data-type="${type}">${TYPE_LABEL[type]}</span>
          <div class="card-actions">
            <button type="button" class="tag-btn${hasTags ? ' is-on' : ''}" data-tagedit="${d.id}" title="${hasTags ? '编辑标签' : '添加标签'}" aria-label="编辑标签" aria-pressed="${hasTags ? 'true' : 'false'}">
              ${tagSvg}
            </button>
            <button type="button" class="star-btn${d.starred ? ' is-on' : ''}" data-star="${d.id}" title="${d.starred ? '取消收藏' : '收藏'}" aria-pressed="${d.starred ? 'true' : 'false'}">
              ${starSvg(!!d.starred)}
            </button>
          </div>
        </div>
        <h3 class="card-title">${escapeHtml(d.title || '未命名')}</h3>
        <p class="card-summary">${escapeHtml(d.summary || '—')}</p>
        <div class="card-tags">${tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}${extra > 0 ? `<span class="more">+${extra}</span>` : ''}</div>
        <div class="card-foot">
          <span>${fmtTime(d.created_at)}</span>
          <span class="dot"></span>
          <span>${fmtSize(d.file_size)}</span>
          <span class="src">${d.source === 'workbuddy' ? '微信推送' : '手动添加'}</span>
        </div>
      </article>`
    }).join('')
  }

  /* ═══════════════ 预览 ═══════════════ */

  async function fetchContent(id) {
    const { data, error } = await cloud.database
      .from('documents')
      .select('content')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('这条内容已经被删掉了')
    return String(data.content || '')
  }

  async function openPreview(doc) {
    current = doc
    currentHtml = ''
    el.previewTitle.textContent = doc.title || '未命名'
    syncPreviewStar()
    el.previewFrame.srcdoc = previewShell('正在载入…')
    el.preview.classList.remove('is-hidden')
    document.body.style.overflow = 'hidden'

    try {
      const html = await fetchContent(doc.id)
      currentHtml = html
      el.previewFrame.srcdoc = html || previewShell('这条内容是空的')
    } catch (err) {
      el.previewFrame.srcdoc = previewShell(`<b>内容载入失败</b>${escapeHtml(friendly(err))}`)
    }
  }

  function closePreview() {
    el.preview.classList.add('is-hidden')
    el.previewFrame.srcdoc = ''
    current = null
    currentHtml = ''
    syncPreviewStar()
    document.body.style.overflow = ''
  }

  function downloadHtml(html, name) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name || 'content').replace(/[\\/:*?"<>|]/g, '_')}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  async function actOnCurrent(act) {
    const doc = current
    if (!doc) return

    if (act === 'star') {
      await toggleStar(doc.id)
      return
    }

    if (act === 'tag') {
      openTagEditor(doc)
      return
    }

    if (act === 'open') {
      try {
        if (!currentHtml) currentHtml = await fetchContent(doc.id)
        const blob = new Blob([currentHtml], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener')
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      } catch (err) {
        toast(friendly(err), 'err')
      }
      return
    }

    if (act === 'download') {
      try {
        if (!currentHtml) currentHtml = await fetchContent(doc.id)
        downloadHtml(currentHtml, doc.title)
      } catch (err) {
        toast(friendly(err), 'err')
      }
      return
    }

    if (act === 'edit') {
      editing = doc
      el.editTitle.value = doc.title || ''
      el.editSummary.value = doc.summary || ''
      el.editTags.value = (doc.tags || []).join(', ')
      renderTagSuggest(el.editTagSuggest, el.editTags)
      el.editType.value = TYPE_KEYS.includes(doc.doc_type) ? doc.doc_type : 'other'
      modalNote(el.editMsg, '')
      el.editModal.classList.remove('is-hidden')
      return
    }

    if (act === 'delete') {
      const ok = window.confirm(`删除「${doc.title || '未命名'}」？\n\n删除后无法恢复。`)
      if (!ok) return
      try {
        const del = await cloud.database.from('documents').delete().eq('id', doc.id).select('id')
        if (del.error) throw del.error
        if (!Array.isArray(del.data) || del.data.length === 0) {
          throw new Error('没有删掉，可能已经不存在了')
        }
        docs = docs.filter((d) => d.id !== doc.id)
        closePreview()
        renderFilters()
        renderDocs()
        toast('已删除', 'ok')
      } catch (err) {
        toast(friendly(err), 'err')
      }
    }
  }

  /* ═══════════════ 写入 ═══════════════ */

  async function archiveOne(item) {
    const html = String(item.html || '')
    if (!html.trim()) throw new Error('内容为空')

    const size = byteLength(html)
    if (size > MAX_CONTENT) throw new Error(`内容 ${fmtSize(size)} 超过 2MB 上限`)

    const row = {
      title: String(item.title || '未命名内容').slice(0, 200),
      summary: String(item.summary || '').slice(0, 500),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, MAX_TAGS) : [],
      doc_type: TYPE_KEYS.includes(item.docType) ? item.docType : 'other',
      source: item.source || 'workbuddy',
      content: html,
      file_size: size
    }

    const ins = await cloud.database.from('documents').insert(row).select(LIST_FIELDS)
    if (ins.error) throw ins.error
    if (!Array.isArray(ins.data) || !ins.data.length) throw new Error('保存失败，云端没返回记录')
    return ins.data[0]
  }

  /* ═══════════════ 收件箱 ═══════════════ */

  async function inboxFetch(path, options) {
    const res = await fetch(path, {
      ...(options || {}),
      headers: { 'x-ingest-key': INGEST_KEY, ...((options && options.headers) || {}) }
    })
    const text = await res.text()
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
      return { ok: false, status: res.status, data: null }
    }
  }

  async function loadInbox() {
    try {
      const res = await inboxFetch('/api/inbox')
      if (!res.ok || !res.data || !res.data.ok) {
        el.inboxBar.classList.add('is-hidden')
        return
      }
      inbox = res.data.items || []
      if (!inbox.length) {
        el.inboxBar.classList.add('is-hidden')
        return
      }
      el.inboxCount.textContent = inbox.length
      const names = inbox.slice(0, 3).map((i) => i.title).join('、')
      el.inboxHint.textContent = inbox.length > 3 ? `${names} 等` : names
      el.inboxBar.classList.remove('is-hidden')
    } catch {
      el.inboxBar.classList.add('is-hidden')
    }
  }

  async function archiveAllInbox() {
    if (!inbox.length) return
    el.btnArchiveAll.disabled = true
    el.btnArchiveAll.textContent = '归档中…'
    let done = 0
    let failed = 0
    let lastErr = null

    for (const item of inbox.slice()) {
      try {
        const res = await inboxFetch(`/api/inbox/${item.id}`)
        if (!res.ok || !res.data || !res.data.ok) throw new Error('读取收件箱失败')
        const meta = res.data.meta || {}
        await archiveOne({
          html: res.data.html,
          title: meta.title || item.title,
          summary: meta.summary || item.summary,
          tags: [],                       // 标签一律留空，由用户自己在页面上打
          docType: meta.docType || item.docType,
          source: 'workbuddy'
        })
        await inboxFetch(`/api/inbox/${item.id}`, { method: 'DELETE' })
        done += 1
      } catch (err) {
        failed += 1
        lastErr = err
        console.warn('归档失败', item.id, err && err.message)
      }
    }

    el.btnArchiveAll.disabled = false
    el.btnArchiveAll.textContent = '全部归档'

    if (done) {
      toast(`已归档 ${done} 个${failed ? `，${failed} 个失败` : ''}`, failed ? 'err' : 'ok')
    } else if (failed) {
      toast(friendly(lastErr), 'err')
    }

    await Promise.all([loadDocs(), loadInbox()])
  }

  async function clearInbox() {
    const ok = window.confirm(`忽略收件箱里的 ${inbox.length} 个内容？\n\n它们不会被归档，并会从收件箱移除。`)
    if (!ok) return
    await inboxFetch('/api/inbox', { method: 'DELETE' })
    toast('已忽略收件箱内容', 'ok')
    await loadInbox()
  }

  /* ═══════════════ 编辑信息 ═══════════════ */

  async function confirmEdit() {
    if (!editing) return
    const patch = {
      title: el.editTitle.value.trim().slice(0, 200) || '未命名',
      summary: el.editSummary.value.trim().slice(0, 500),
      tags: splitTags(el.editTags.value).slice(0, MAX_TAGS),
      doc_type: TYPE_KEYS.includes(el.editType.value) ? el.editType.value : 'other',
      updated_at: new Date().toISOString()
    }

    el.editConfirm.disabled = true
    el.editConfirm.textContent = '保存中…'

    try {
      const res = await cloud.database.from('documents').update(patch).eq('id', editing.id).select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || res.data.length === 0) throw new Error('没有保存成功')

      const idx = docs.findIndex((d) => String(d.id) === String(editing.id))
      if (idx >= 0) docs[idx] = { ...docs[idx], ...patch }
      if (current && String(current.id) === String(editing.id)) {
        current = idx >= 0 ? docs[idx] : { ...current, ...patch }
        el.previewTitle.textContent = patch.title
      }

      el.editModal.classList.add('is-hidden')
      editing = null
      renderFilters()
      renderDocs()
      toast('已保存', 'ok')
    } catch (err) {
      modalNote(el.editMsg, friendly(err), 'error')
    } finally {
      el.editConfirm.disabled = false
      el.editConfirm.textContent = '保存'
    }
  }

  /* ═══════════════ 编辑标签 ═══════════════
     每张卡片右上角的标签按钮都能直接打开，不用先点进预览页。 */

  function openTagEditor(doc) {
    tagEditing = doc
    tagDraft = Array.isArray(doc.tags) ? doc.tags.slice() : []
    el.tagDoc.textContent = doc.title || '未命名'
    el.tagInput.value = ''
    modalNote(el.tagMsg, '')
    renderTagEditor()
    el.tagModal.classList.remove('is-hidden')
    setTimeout(() => el.tagInput.focus(), 60)
  }

  function closeTagEditor() {
    el.tagModal.classList.add('is-hidden')
    tagEditing = null
    tagDraft = []
  }

  function renderTagEditor() {
    // 当前已打的标签
    el.tagCurrent.innerHTML = tagDraft.length
      ? tagDraft.map((t) =>
          `<span class="tag-chip">${escapeHtml(t)}<button type="button" data-tagdrop="${escapeHtml(t)}" title="移除" aria-label="移除 ${escapeHtml(t)}">✕</button></span>`
        ).join('')
      : '<span class="tag-empty">还没打标签</span>'

    // 库里已有的标签，点一下加入 / 再点移除 —— 引导复用一个词
    const pool = tagCounts(docs).map((e) => e[0])
    if (!pool.length) {
      el.tagPool.innerHTML = ''
      return
    }
    el.tagPool.innerHTML =
      '<span class="tag-pool-label">已有标签 · 点一下加入，再点移除</span>' +
      pool.map((t) =>
        `<button type="button" class="tag-opt${tagDraft.includes(t) ? ' is-on' : ''}" data-tagtoggle="${escapeHtml(t)}" aria-pressed="${tagDraft.includes(t) ? 'true' : 'false'}">${escapeHtml(t)}</button>`
      ).join('')
  }

  /** 把输入框里的内容并进草稿（支持一次输入多个，逗号/空格分隔） */
  function commitTagInput() {
    const raw = el.tagInput.value
    if (!raw.trim()) return
    let full = false
    splitTags(raw).forEach((t) => {
      if (tagDraft.includes(t)) return
      if (tagDraft.length >= MAX_TAGS) { full = true; return }
      tagDraft.push(t)
    })
    el.tagInput.value = ''
    renderTagEditor()
    if (full) modalNote(el.tagMsg, `一条内容最多 ${MAX_TAGS} 个标签`, 'error')
    else modalNote(el.tagMsg, '')
  }

  function toggleDraftTag(tag) {
    if (tagDraft.includes(tag)) {
      tagDraft = tagDraft.filter((t) => t !== tag)
    } else {
      if (tagDraft.length >= MAX_TAGS) {
        modalNote(el.tagMsg, `一条内容最多 ${MAX_TAGS} 个标签`, 'error')
        return
      }
      tagDraft.push(tag)
    }
    modalNote(el.tagMsg, '')
    renderTagEditor()
  }

  async function saveTags() {
    if (!tagEditing) return
    commitTagInput()

    const target = tagEditing
    const patch = { tags: tagDraft.slice(0, MAX_TAGS), updated_at: new Date().toISOString() }

    el.tagSave.disabled = true
    el.tagSave.textContent = '保存中…'

    try {
      const res = await cloud.database.from('documents').update(patch).eq('id', target.id).select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || res.data.length === 0) throw new Error('没有保存成功')

      const idx = docs.findIndex((d) => String(d.id) === String(target.id))
      if (idx >= 0) docs[idx] = { ...docs[idx], ...patch }
      if (current && String(current.id) === String(target.id)) current = docs[idx] || { ...current, ...patch }

      closeTagEditor()
      renderFilters()
      renderDocs()
      toast(patch.tags.length ? `标签已更新（${patch.tags.length} 个）` : '标签已清空', 'ok')
    } catch (err) {
      modalNote(el.tagMsg, friendly(err), 'error')
    } finally {
      el.tagSave.disabled = false
      el.tagSave.textContent = '保存'
    }
  }

  /* ═══════════════ 收藏 ═══════════════ */

  async function toggleStar(id) {
    const doc = docs.find((d) => String(d.id) === String(id))
    if (!doc) return
    const next = !doc.starred
    doc.starred = next
    renderFilters()
    renderDocs()
    syncPreviewStar()
    try {
      const res = await cloud.database.from('documents').update({ starred: next }).eq('id', doc.id).select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || res.data.length === 0) throw new Error('未生效')
      toast(next ? '已加入收藏' : '已取消收藏', 'ok')
    } catch (err) {
      doc.starred = !next
      renderFilters()
      renderDocs()
      syncPreviewStar()
      toast('收藏更新失败', 'err')
    }
  }

  /** 同步预览页顶部的收藏按钮状态 */
  function syncPreviewStar() {
    if (!el.previewStar) return
    const on = !!(current && current.starred)
    el.previewStar.classList.toggle('is-on', on)
    const label = el.previewStar.querySelector('span')
    if (label) label.textContent = on ? '已收藏' : '收藏'
  }

  /* ═══════════════ 收藏深链 ═══════════════
     地址栏带 #fav 时直接进收藏视角，方便存成书签一步到达。 */

  function readHash() {
    const h = decodeURIComponent(String(location.hash || '')).replace(/^#/, '').trim().toLowerCase()
    return h === 'fav' || h === 'starred' || h === '收藏'
  }

  function writeHash() {
    const clean = location.pathname + location.search
    if (view.starred && location.hash !== '#fav') {
      history.replaceState(null, '', clean + '#fav')
    } else if (!view.starred && location.hash) {
      history.replaceState(null, '', clean)
    }
  }

  /* ═══════════════ 留言板 ═══════════════
     站点公开，谁都能留；数据存在云数据库 messages 表。 */

  function updateMsgBadge() {
    const n = messages.length
    el.msgBadge.textContent = n > 99 ? '99+' : String(n)
    el.msgBadge.classList.toggle('is-hidden', n === 0)
  }

  async function loadMessages(silent) {
    if (msgLoading) return
    msgLoading = true
    try {
      const res = await cloud.database.from('messages').select(MSG_FIELDS)
        .order('created_at', { ascending: false }).limit(200)
      if (res.error) throw res.error
      messages = Array.isArray(res.data) ? res.data : []
      updateMsgBadge()
      if (!el.msgModal.classList.contains('is-hidden')) renderMessages()
    } catch (err) {
      if (!silent) modalNote(el.msgMsg, friendly(err), 'error')
    } finally {
      msgLoading = false
    }
  }

  function renderMessages() {
    if (!messages.length) {
      el.msgList.innerHTML = '<p class="msg-empty">还没有留言，说第一句吧。</p>'
      return
    }
    el.msgList.innerHTML = messages.map((m) => `
      <article class="msg-item" data-id="${escapeHtml(m.id)}">
        <div class="msg-meta">
          <strong>${escapeHtml(m.author || '匿名')}</strong>
          <span class="msg-time">${escapeHtml(fmtTime(m.created_at))}</span>
          <button type="button" class="msg-del" data-msgdel="${escapeHtml(m.id)}" title="删除这条留言" aria-label="删除这条留言">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <p class="msg-text">${escapeHtml(m.body)}</p>
      </article>`).join('')
  }

  function openMsgBoard() {
    el.msgModal.classList.remove('is-hidden')
    el.msgAuthor.value = localStorage.getItem(AUTHOR_KEY) || ''
    modalNote(el.msgMsg, '')
    renderMessages()
    loadMessages()
    setTimeout(() => el.msgBody.focus(), 80)
  }

  function closeMsgBoard() {
    el.msgModal.classList.add('is-hidden')
    modalNote(el.msgMsg, '')
  }

  async function sendMessage() {
    const body = el.msgBody.value.trim()
    if (!body) {
      modalNote(el.msgMsg, '还没写内容', 'error')
      el.msgBody.focus()
      return
    }
    if (body.length > MSG_MAX) {
      modalNote(el.msgMsg, `最多 ${MSG_MAX} 字`, 'error')
      return
    }

    const author = el.msgAuthor.value.trim()
    try { localStorage.setItem(AUTHOR_KEY, author) } catch (_) { /* 隐私模式忽略 */ }

    el.msgSend.disabled = true
    el.msgSend.textContent = '发送中…'
    try {
      const res = await cloud.database.from('messages')
        .insert({ author: author || '匿名', body })
        .select(MSG_FIELDS)
      if (res.error) throw res.error
      const row = Array.isArray(res.data) && res.data[0]
        ? res.data[0]
        : { id: `local-${Date.now()}`, author: author || '匿名', body, created_at: new Date().toISOString() }
      messages.unshift(row)
      el.msgBody.value = ''
      updateMsgBadge()
      renderMessages()
      modalNote(el.msgMsg, '已发出', 'ok')
    } catch (err) {
      modalNote(el.msgMsg, friendly(err), 'error')
    } finally {
      el.msgSend.disabled = false
      el.msgSend.textContent = '发送'
    }
  }

  async function deleteMessage(id) {
    const m = messages.find((x) => String(x.id) === String(id))
    if (!m) return
    if (!window.confirm(`删除这条留言？\n\n${String(m.body).slice(0, 60)}`)) return
    try {
      const res = await cloud.database.from('messages').delete().eq('id', m.id).select('id')
      if (res.error) throw res.error
      messages = messages.filter((x) => String(x.id) !== String(id))
      updateMsgBadge()
      renderMessages()
      toast('留言已删除', 'ok')
    } catch (err) {
      modalNote(el.msgMsg, friendly(err), 'error')
    }
  }

  /* ═══════════════ 推送数据开放接口说明 ═══════════════
     文档里的端点、密钥、示例全部由真实配置拼出来，只写实测可用的用法。 */

  const API_FIELDS = [
    ['title', '必填', '标题，显示在卡片上'],
    ['content', '必填', 'HTML 源码全文'],
    ['summary', '选填', '一句话摘要，卡片上展示'],
    ['doc_type', '选填', 'report / dashboard / tool / page / other'],
    ['source', '选填', '来源标记，例如自己的脚本名'],
    ['file_size', '选填', '内容字节数'],
    ['tags', '选填', '建议留空 [] —— 标签在页面上手工维护']
  ]

  function openApiDoc() {
    renderApiDoc()
    el.apiModal.classList.remove('is-hidden')
  }

  function closeApiDoc() {
    el.apiModal.classList.add('is-hidden')
  }

  function renderApiDoc() {
    const key = CFG.publishableKey || '(缺少 publishableKey)'
    const k = escapeHtml(key)
    const url = escapeHtml(API_URL)
    const rest = escapeHtml(REST_BASE)
    const sample = escapeHtml(JSON.stringify({
      title: '美股盘前快报 · 9月19日',
      summary: '隔夜三大指数收涨',
      doc_type: 'report',
      source: 'my-script',
      content: '<!DOCTYPE html><html>…</html>'
    }))
    el.apiBody.innerHTML = `
      <p class="api-lead">任何能发 HTTP 请求的地方都能往这里推内容 —— 不需要账号，推完立刻出现在页面上。</p>

      <h4 class="api-h">端点</h4>
      <pre class="api-code">POST ${url}</pre>

      <h4 class="api-h">请求头</h4>
      <pre class="api-code">x-wb-webapp-access-key: ${k}
content-type: application/json
Prefer: return=representation</pre>

      <h4 class="api-h">字段</h4>
      <div class="api-fields">${API_FIELDS.map(([n, req, desc]) =>
        `<div class="api-field"><code>${n}</code><span class="api-req${req === '必填' ? ' is-need' : ''}">${req}</span><span class="api-desc">${desc}</span></div>`
      ).join('')}</div>

      <h4 class="api-h">推送一条内容</h4>
      <pre class="api-code">curl -X POST '${url}' \\
  -H 'x-wb-webapp-access-key: ${k}' \\
  -H 'content-type: application/json' \\
  -H 'Prefer: return=representation' \\
  -d '${sample}'</pre>

      <h4 class="api-h">读取</h4>
      <pre class="api-code"># 列表（不带正文，返回快）
GET ${rest}/documents?select=id,title,tags&order=created_at.desc

# 单条正文
GET ${rest}/documents?select=content&id=eq.1</pre>

      <h4 class="api-h">删除</h4>
      <pre class="api-code">DELETE ${rest}/documents?id=eq.1</pre>

      <h4 class="api-h">说明</h4>
      <ul class="api-notes">
        <li>把路径里的 <code>documents</code> 换成 <code>messages</code> 就是留言表，用法完全一样。</li>
        <li>失败时响应体里有 <code>code</code> 与 <code>message</code>，照它排查即可。</li>
        <li>建议单条内容控制在 2MB 以内 —— 页面入库时按同一上限校验。</li>
        <li>仓库里的 <code>tools/push.mjs</code> 走的就是这个接口。</li>
        <li><strong>这个密钥是公开的</strong>：它随页面发给了每个访客，所以把站点地址给谁，就等于允许谁写入。</li>
      </ul>`
  }

  async function copyApiUrl() {
    try {
      await navigator.clipboard.writeText(API_URL)
      toast('接口地址已复制', 'ok')
    } catch (_) {
      // 非安全上下文或权限被拒时退回手选
      const ta = document.createElement('textarea')
      ta.value = API_URL
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); toast('接口地址已复制', 'ok') }
      catch (e) { toast('复制失败，请手动选中', 'err') }
      ta.remove()
    }
  }

  /* ═══════════════ 事件绑定 ═══════════════ */

  function bindEvents() {
    el.sort.addEventListener('change', () => {
      view.sort = el.sort.value
      renderDocs()
    })
    el.btnRefresh.addEventListener('click', () => loadDocs(true))

    // 顶栏：接口说明 / 留言
    el.btnApi.addEventListener('click', openApiDoc)
    el.apiClose.addEventListener('click', closeApiDoc)
    el.apiOk.addEventListener('click', closeApiDoc)
    el.apiCopy.addEventListener('click', copyApiUrl)

    el.btnMsg.addEventListener('click', openMsgBoard)
    el.msgClose.addEventListener('click', closeMsgBoard)
    el.msgSend.addEventListener('click', sendMessage)
    el.msgBody.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        sendMessage()
      }
    })
    el.msgList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-msgdel]')
      if (btn) deleteMessage(btn.dataset.msgdel)
    })

    el.typeChips.addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]')
      if (fav) {
        view.starred = !view.starred
        view.tag = ''                       // 切换收藏视角时清掉标签，避免选中的标签被筛掉后消失
        writeHash()
        renderFilters()
        renderDocs()
        return
      }
      const btn = e.target.closest('[data-type]')
      if (!btn) return
      view.type = btn.dataset.type
      renderFilters()
      renderDocs()
    })

    el.tagRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tag]')
      if (!btn) return
      view.tag = btn.dataset.tag
      renderFilters()
      renderDocs()
    })

    el.grid.addEventListener('click', (e) => {
      const tagBtn = e.target.closest('[data-tagedit]')
      if (tagBtn) {
        e.stopPropagation()
        const doc = docs.find((d) => String(d.id) === tagBtn.dataset.tagedit)
        if (doc) openTagEditor(doc)
        return
      }
      const star = e.target.closest('[data-star]')
      if (star) {
        e.stopPropagation()
        toggleStar(star.dataset.star)
        return
      }
      const card = e.target.closest('.card')
      if (!card) return
      const doc = docs.find((d) => String(d.id) === card.dataset.id)
      if (doc) openPreview(doc)
    })

    // 标签弹窗
    el.tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault()
        commitTagInput()
        return
      }
      // 输入框空着时按退格，删掉最后一个标签
      if (e.key === 'Backspace' && !el.tagInput.value && tagDraft.length) {
        e.preventDefault()
        tagDraft.pop()
        renderTagEditor()
      }
    })
    el.tagInput.addEventListener('blur', commitTagInput)
    el.tagCurrent.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tagdrop]')
      if (!btn) return
      tagDraft = tagDraft.filter((t) => t !== btn.dataset.tagdrop)
      renderTagEditor()
    })
    el.tagPool.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tagtoggle]')
      if (btn) toggleDraftTag(btn.dataset.tagtoggle)
    })
    el.tagSave.addEventListener('click', saveTags)
    el.tagCancel.addEventListener('click', closeTagEditor)
    el.tagClose.addEventListener('click', closeTagEditor)

    // 编辑信息弹窗里的标签输入 + 已有标签快捷追加
    el.editTags.addEventListener('input', () => renderTagSuggest(el.editTagSuggest, el.editTags))
    el.editTagSuggest.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-suggest]')
      if (btn) addSuggestedTag(el.editTags, btn.dataset.suggest)
    })

    el.editClose.addEventListener('click', () => {
      el.editModal.classList.add('is-hidden')
      editing = null
    })
    el.editCancel.addEventListener('click', () => {
      el.editModal.classList.add('is-hidden')
      editing = null
    })
    el.editConfirm.addEventListener('click', confirmEdit)

    el.btnArchiveAll.addEventListener('click', archiveAllInbox)
    el.btnDismissInbox.addEventListener('click', clearInbox)

    el.previewBack.addEventListener('click', closePreview)
    el.previewActions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]')
      if (btn) actOnCurrent(btn.dataset.act)
    })

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!el.apiModal.classList.contains('is-hidden')) return closeApiDoc()
      if (!el.msgModal.classList.contains('is-hidden')) return closeMsgBoard()
      if (!el.tagModal.classList.contains('is-hidden')) return closeTagEditor()
      if (!el.editModal.classList.contains('is-hidden')) {
        el.editModal.classList.add('is-hidden')
        editing = null
        return
      }
      if (!el.preview.classList.contains('is-hidden')) return closePreview()
    })

    window.addEventListener('hashchange', () => {
      const next = readHash()
      if (next === view.starred) return
      view.starred = next
      view.tag = ''
      renderFilters()
      renderDocs()
    })

    // 点遮罩关闭（留言板刻意不关：正打字时误触很烦）
    const closers = new Map([
      [el.editModal, () => { el.editModal.classList.add('is-hidden'); editing = null }],
      [el.tagModal, closeTagEditor],
      [el.apiModal, closeApiDoc]
    ])
    closers.forEach((close, modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) close()
      })
    })
  }

  /* ═══════════════ 启动 ═══════════════ */

  function start() {
    bindEvents()

    view.starred = readHash()

    try {
      cloud = initCloud()
    } catch (err) {
      el.boot.innerHTML = `<p style="color:#dc2626;max-width:340px;text-align:center;line-height:1.6">${escapeHtml(err.message)}</p>`
      return
    }

    el.boot.classList.add('is-hidden')
    el.mainView.classList.remove('is-hidden')
    loadDocs()
    loadInbox()
    loadMessages(true)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
