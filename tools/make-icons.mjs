#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 图标光栅化
 *
 * 把 public/favicon.svg 渲染成各种尺寸的位图，并合成 favicon.ico。
 * 浏览器主图标仍是矢量 SVG，这里生成的位图用于：
 *   - apple-touch-icon.png（iOS 添加到主屏，180×180）
 *   - favicon-32.png（老浏览器兜底）
 *   - favicon.ico（16/24/32/48 多尺寸，内嵌 PNG）
 *
 * 用法：node tools/make-icons.mjs
 *
 * 依赖 @resvg/resvg-js，装在托管 Node 工作区里，不从项目依赖里引。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

// resvg 装在托管 Node 工作区，用 createRequire 从那里解析
const WORKSPACE = process.env.NODE_WORKSPACE ||
  'C:/Users/chenq/.workbuddy/binaries/node/workspace'
const require = createRequire(path.join(WORKSPACE, 'noop.js'))
const { Resvg } = require('@resvg/resvg-js')

const SVG_FILE = path.join(PUBLIC_DIR, 'favicon.svg')

function render(svg, width) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } })
  return Buffer.from(resvg.render().asPng())
}

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)          // type: icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach((img, i) => {
    const b = i * 16
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 0)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 1)
    dir.writeUInt8(0, b + 2)
    dir.writeUInt8(0, b + 3)
    dir.writeUInt16LE(1, b + 4)
    dir.writeUInt16LE(32, b + 6)
    dir.writeUInt32LE(img.png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += img.png.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

function main() {
  const svg = fs.readFileSync(SVG_FILE, 'utf8')

  // iOS 会自己裁圆角，所以主屏图标用满幅直角底，避免出现双层圆角
  const flat = svg.replace('rx="8"', 'rx="0"')

  const written = []
  const write = (name, buf, label) => {
    fs.writeFileSync(path.join(PUBLIC_DIR, name), buf)
    written.push(`${name}  ${buf.length} B  ${label}`)
  }

  write('apple-touch-icon.png', render(flat, 180), 'iOS 主屏，满幅直角')
  write('favicon-32.png', render(svg, 32), '老浏览器兜底')

  const ico = buildIco([16, 24, 32, 48].map((size) => ({ size, png: render(svg, size) })))
  write('favicon.ico', ico, '多尺寸 16/24/32/48')

  console.log('图标已生成：')
  for (const w of written) console.log('  · ' + w)
}

main()
