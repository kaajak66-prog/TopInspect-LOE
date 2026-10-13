/* ═══════════════════════════════════════════════════════════════════════
   回归测试：侧栏模块放大「实时镜像」——原件 DOM 更新同步到克隆。
   用最小 DOM + MutationObserver 垫片驱动 src/components/mirrorExpand.js，
   验证文本 / 样式属性 / 子节点增删（innerHTML 换图标）/ canvas 重绘钩子
   四条镜像路径。运行：cd frontend && node tests/repro_mirror.mjs
   ═══════════════════════════════════════════════════════════════════════ */
let failures = 0
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name) }
  else { failures++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')) }
}

/* ═══════ 最小 DOM 垫片 ═══════ */
const observedRoots = new Set()
const pendingMuts = []
const registeredObs = []

function underObserved(node) {
  let cur = node
  while (cur) { if (observedRoots.has(cur)) return true; cur = cur.parentNode }
  return false
}
function record(m) { if (underObserved(m.target)) pendingMuts.push(m) }

class MutationObserverStub {
  constructor(cb) { this.cb = cb; this.observed = false }
  observe(target, opts) { this.target = target; this.observed = true; observedRoots.add(target); registeredObs.push(this) }
  disconnect() { this.observed = false; observedRoots.delete(this.target); registeredObs.splice(registeredObs.indexOf(this), 1) }
  static flush() {
    if (!pendingMuts.length) return
    const batch = pendingMuts.splice(0)
    for (const o of registeredObs) if (o.observed) o.cb(batch)
  }
}
globalThis.MutationObserver = MutationObserverStub

let uid = 0
function mkText(data) {
  return {
    nodeType: 3, nodeName: '#text', parentNode: null, data: String(data),
    get textContent() { return this.data },
    set textContent(v) { this.data = String(v) },
    cloneNode() { return mkText(this.data) },
  }
}
function serializeStyle(style) {
  return Object.keys(style).map(k => k + ':' + style[k] + ';').join('')
}
function parseStyle(el, str) {
  el._style = {}
  String(str || '').split(';').forEach(part => {
    const i = part.indexOf(':')
    if (i > 0) el._style[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  })
}

function mkEl(tag) {
  const n = {
    nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(),
    childNodes: [], parentNode: null, _attrs: {}, _style: {}, id: '', className: '', _uid: ++uid,
  }
  Object.defineProperty(n, 'style', {
    get() {
      return new Proxy({}, {
        get: (o, k) => n._style[k],
        set: (o, k, v) => { n._style[k] = String(v); n._attrs.style = serializeStyle(n._style); if (underObserved(n)) record({ type: 'attributes', target: n, attributeName: 'style' }); return true },
        deleteProperty: (o, k) => { delete n._style[k]; n._attrs.style = serializeStyle(n._style); if (underObserved(n)) record({ type: 'attributes', target: n, attributeName: 'style' }); return true },
      })
    },
    configurable: true,
  })
  n.setAttribute = function (k, v) {
    const prev = this._attrs[k]
    this._attrs[k] = String(v)
    if (k === 'id') this.id = String(v)
    if (k === 'class') this.className = String(v)
    if (k === 'style') parseStyle(this, v)
    if (underObserved(this)) record({ type: 'attributes', target: this, attributeName: k, oldValue: prev })
  }
  n.removeAttribute = function (k) {
    if (!this._attrs[k]) return
    delete this._attrs[k]
    if (k === 'id') this.id = ''
    if (k === 'class') this.className = ''
    if (k === 'style') this._style = {}
    if (underObserved(this)) record({ type: 'attributes', target: this, attributeName: k })
  }
  n.getAttribute = function (k) { return this._attrs[k] != null ? String(this._attrs[k]) : null }
  n.hasAttribute = function (k) { return this._attrs[k] != null }
  n.appendChild = function (c) {
    const prev = this.childNodes[this.childNodes.length - 1]
    c.parentNode = this
    this.childNodes.push(c)
    if (underObserved(this)) record({ type: 'childList', target: this, addedNodes: [c], removedNodes: [], nextSibling: null, previousSibling: prev || null })
    return c
  }
  n.removeChild = function (c) {
    const i = this.childNodes.indexOf(c)
    if (i < 0) return c
    const ns = this.childNodes[i + 1] || null
    this.childNodes.splice(i, 1)
    c.parentNode = null
    if (underObserved(this)) record({ type: 'childList', target: this, addedNodes: [], removedNodes: [c], nextSibling: ns, previousSibling: this.childNodes[i - 1] || null })
    return c
  }
  n.insertBefore = function (c, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1
    const prev = i > 0 ? this.childNodes[i - 1] : null
    c.parentNode = this
    if (i >= 0) this.childNodes.splice(i, 0, c)
    else this.childNodes.push(c)
    if (underObserved(this)) record({ type: 'childList', target: this, addedNodes: [c], removedNodes: [], nextSibling: ref || null, previousSibling: prev || null })
    return c
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this.childNodes.map(c => c.nodeType === 3 ? c.data : c.textContent).join('') },
    set(v) {
      v = String(v)
      if (this.childNodes.length === 1 && this.childNodes[0].nodeType === 3) {
        const tn = this.childNodes[0]
        if (tn.data !== v) { tn.data = v; if (underObserved(this)) record({ type: 'characterData', target: tn }) }
        return
      }
      const removed = this.childNodes.slice()
      const tn = mkText(v)
      tn.parentNode = this
      this.childNodes = [tn]
      for (const c of removed) c.parentNode = null
      if (underObserved(this)) record({ type: 'childList', target: this, addedNodes: [tn], removedNodes: removed, nextSibling: null, previousSibling: null })
    },
    configurable: true,
  })
  Object.defineProperty(n, 'innerHTML', {
    set(v) {
      const frag = parseHTML(v)
      const removed = this.childNodes.slice()
      const added = frag.childNodes
      this.childNodes = []
      for (const c of removed) c.parentNode = null
      for (const c of added) { c.parentNode = this; this.childNodes.push(c) }
      if (underObserved(this) && (removed.length || added.length)) record({ type: 'childList', target: this, addedNodes: added, removedNodes: removed, nextSibling: null, previousSibling: null })
    },
    get() { return this.childNodes.map(c => c.nodeType === 3 ? c.data : '<' + c.nodeName.toLowerCase() + ' class="' + (c._attrs.class || '') + '">' + (c.innerHTML || '') + '</' + c.nodeName.toLowerCase() + '>').join('') },
    configurable: true,
  })
  n.cloneNode = function (deep) {
    const c = mkEl(this.tagName)
    for (const k in this._attrs) c._attrs[k] = this._attrs[k]
    parseStyle(c, this._attrs.style)
    c.id = this.id; c.className = this.className
    if (deep) for (const ch of this.childNodes) { const cc = ch.cloneNode(true); cc.parentNode = c; c.childNodes.push(cc) }
    return c
  }
  n.querySelector = function (sel) {
    function walk(node) {
      for (const ch of node.childNodes) {
        if (ch.nodeType !== 1) continue
        if (sel[0] === '#' ? ch.id === sel.slice(1) : sel[0] === '.' ? ch.className.split(' ').includes(sel.slice(1)) : ch.nodeName === sel.toUpperCase()) return ch
        const r = walk(ch)
        if (r) return r
      }
      return null
    }
    return walk(this)
  }
  n.classList = {
    add: (...cs) => { const set = new Set(n.className.split(' ').filter(Boolean)); cs.forEach(c => set.add(c)); const nc = [...set].join(' '); if (nc !== n.className) n.setAttribute('class', nc) },
    remove: (...cs) => { const set = new Set(n.className.split(' ').filter(Boolean)); cs.forEach(c => set.delete(c)); const nc = [...set].join(' '); if (nc !== n.className) n.setAttribute('class', nc) },
    contains: c => n.className.split(' ').includes(c),
  }
  n.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 120 })
  n.addEventListener = () => {}
  n.removeEventListener = () => {}
  return n
}

/* 极简 HTML 解析（仅支持 <tag attr="val">text</tag> 的平铺结构，够测试用） */
function parseHTML(html) {
  const frag = { nodeType: 11, childNodes: [] }
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>/g
  let last = 0, m
  const stack = [frag]
  while ((m = re.exec(html))) {
    if (m.index > last) { const txt = html.slice(last, m.index); if (txt.trim()) stack[stack.length - 1].childNodes.push(mkText(txt)) }
    last = re.lastIndex
    if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue }
    const el = mkEl(m[2])
    const attrRe = /([a-zA-Z-]+)="([^"]*)"/g; let am
    while ((am = attrRe.exec(m[3]))) el.setAttribute(am[1], am[2])
    const parent = stack[stack.length - 1]
    el.parentNode = parent
    parent.childNodes.push(el)
    if (m[4] !== '/') stack.push(el)
  }
  const txt = html.slice(last)
  if (txt.trim()) frag.childNodes.push(mkText(txt))
  return frag
}

const documentStub = { createElement: t => mkEl(t), body: mkEl('body'), addEventListener: () => {}, removeEventListener: () => {}, contains: () => true }
globalThis.document = documentStub

/* ═══════ 测试 ═══════ */
import { startMirror, stopMirror, linkMirror, findMirror } from '../src/components/mirrorExpand.js'

/* —— 1) 文本镜像（characterData） —— */
console.log('1) textContent 实时镜像')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const val = mkEl('div'); val.setAttribute('id', 'lcFlows'); val.textContent = '—'
  mod.appendChild(val)
  const clone = mod.cloneNode(true)
  startMirror({ el: mod, clone, timeline: null, dist: null, cloneTimeline: null, cloneDist: null })
  mod.querySelector('#lcFlows').textContent = '42'
  MutationObserverStub.flush()
  check('原件改文本 → 克隆同步', clone.querySelector('#lcFlows').textContent === '42', 'got ' + clone.querySelector('#lcFlows').textContent)
}

/* —— 2) 样式属性镜像（style.width 等） —— */
console.log('\n2) style 属性实时镜像')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const bar = mkEl('div'); bar.setAttribute('id', 'tovAffectedBar'); bar.style.width = '0%'
  mod.appendChild(bar)
  const clone = mod.cloneNode(true)
  startMirror({ el: mod, clone, timeline: null, dist: null, cloneTimeline: null, cloneDist: null })
  bar.style.width = '42%'
  MutationObserverStub.flush()
  check('原件改 width → 克隆同步', clone.querySelector('#tovAffectedBar').style.width === '42%', 'got ' + clone.querySelector('#tovAffectedBar').style.width)
  bar.removeAttribute('style')
  MutationObserverStub.flush()
  check('原件移除 style → 克隆同步移除', clone.querySelector('#tovAffectedBar').hasAttribute('style') === false)
}

/* —— 3) 子节点增删镜像（innerHTML 换图标，btnPlayPause 播放/暂停） —— */
console.log('\n3) innerHTML 子节点增删实时镜像')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const btn = mkEl('button'); btn.setAttribute('id', 'btnPlayPause'); btn.innerHTML = '<i class="fa-solid fa-play"></i>'
  mod.appendChild(btn)
  const clone = mod.cloneNode(true)
  startMirror({ el: mod, clone, timeline: null, dist: null, cloneTimeline: null, cloneDist: null })
  check('初始：克隆有播放图标', clone.querySelector('#btnPlayPause').childNodes.length === 1 && clone.querySelector('#btnPlayPause').childNodes[0]._attrs.class === 'fa-solid fa-play')
  btn.innerHTML = '<i class="fa-solid fa-pause"></i>'
  MutationObserverStub.flush()
  const cBtn = clone.querySelector('#btnPlayPause')
  const ok = cBtn.childNodes.length === 1 && cBtn.childNodes[0].nodeType === 1 && cBtn.childNodes[0]._attrs.class === 'fa-solid fa-pause'
  check('原件换图标 → 克隆图标同步切换', ok, 'children=' + cBtn.childNodes.length)
}

/* —— 4) canvas 重绘钩子：原件 canvas width 变化 → 按放大尺寸重绘克隆 —— */
console.log('\n4) canvas 重绘钩子')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const tl = mkEl('canvas'); tl.setAttribute('id', 'chartTimeline')
  const dist = mkEl('canvas'); dist.setAttribute('id', 'chartScoreDist')
  mod.appendChild(tl); mod.appendChild(dist)
  const clone = mod.cloneNode(true)
  const cloneTl = clone.querySelector('#chartTimeline'), cloneDist = clone.querySelector('#chartScoreDist')
  const calls = []
  globalThis.window = { renderSnapshotInto: t => calls.push(t) }
  startMirror({ el: mod, clone, timeline: tl, dist, cloneTimeline: cloneTl, cloneDist })
  tl.setAttribute('width', '960')
  MutationObserverStub.flush()   // 触发 80ms 节流
  await new Promise(r => setTimeout(r, 150))
  check('原件 canvas 重绘 → 克隆画布被重绘', calls.length >= 1, 'calls=' + calls.length)
  check('重绘目标是克隆 canvas（非原件）', calls.length && calls[0].timeline === cloneTl && calls[0].dist === cloneDist && calls[0].ratio === null)
}

/* —— 5) stopMirror 后不再镜像 —— */
console.log('\n5) stopMirror 断开镜像')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const val = mkEl('div'); val.setAttribute('id', 'lcFlows'); val.textContent = '—'
  mod.appendChild(val)
  const clone = mod.cloneNode(true)
  const a = { el: mod, clone, timeline: null, dist: null, cloneTimeline: null, cloneDist: null }
  startMirror(a)
  stopMirror(a)   // 与 startMirror 用同一个 active 对象（panelExpand 中正是如此）
  mod.querySelector('#lcFlows').textContent = '99'
  MutationObserverStub.flush()
  check('断开后原件更新不再同步到克隆', clone.querySelector('#lcFlows').textContent === '—')
}

/* —— 6) linkMirror/findMirror 结构映射 —— */
console.log('\n6) 结构映射')
{
  const mod = mkEl('div'); mod.setAttribute('class', 'card spot panel-module')
  const title = mkEl('div'); title.setAttribute('class', 'card-title'); title.textContent = '实时统计'
  const row = mkEl('div'); row.setAttribute('class', 'stat-row')
  const cell = mkEl('div'); cell.setAttribute('class', 'stat-cell')
  const v = mkEl('div'); v.setAttribute('id', 'lcFlows'); v.textContent = '0'
  cell.appendChild(v); row.appendChild(cell); mod.appendChild(title); mod.appendChild(row)
  const clone = mod.cloneNode(true)
  linkMirror(mod, clone)
  check('findMirror 命中文本节点', findMirror(clone, v.childNodes[0]) === clone.querySelector('#lcFlows').childNodes[0])
  check('findMirror 命中元素节点', findMirror(clone, v) === clone.querySelector('#lcFlows'))
  check('findMirror 对无对应节点返回 null', findMirror(clone, mkEl('x')) === null)
}

console.log('\n────────')
if (failures > 0) {
  console.log(`✗ ${failures} 处断言失败`)
  process.exitCode = 1
} else {
  console.log('✓ 全部断言通过：放大克隆与原件实时同步')
}
