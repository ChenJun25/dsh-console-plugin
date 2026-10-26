import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const MEME_TEXT_RE = /\[表情[:：]\s*([^\]\n]+)\](?:\(\s*([^)\n]+?)\s*\))?/g

const MEME_MAX_BYTES = 8 * 1024 * 1024

const ROWS_TTL_MS = 60 * 1000
const ROWS_RETRY_MS = 10 * 1000

const SELECT_ROWS = "SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes"

let sqliteMod = null
let sqliteTried = false

function sqlite() {
  if (sqliteTried) return sqliteMod
  sqliteTried = true
  try {
    const req = createRequire(import.meta.url)
    const mod = req('node:sqlite')
    if (mod && typeof mod.DatabaseSync === 'function') sqliteMod = mod
  } catch (e) {
    sqliteMod = null
  }
  return sqliteMod
}

const foldCaption = (s) => String(s || '').trim()
  .replace(/[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u00ab\u00bb]/g, '"')
  .replace(/\s+/g, ' ')

const looseCaption = (s) => foldCaption(s).replace(/["'\s]/g, '')

const splitDescTokens = (s) => foldCaption(s)
  .split(/[\s,.!?;:、，。！？；：""''()（）\[\]【】《》…·～~\-]+/)
  .map((t) => t.replace(/["']/g, ''))
  .filter((t) => t.length >= 2)
  .sort((a, b) => b.length - a.length)

const addIndexKey = (map, key, ref) => {
  const raw = String(key || '').trim()
  if (!raw) return
  for (const form of new Set([raw, foldCaption(raw), looseCaption(raw)])) {
    if (form && !map.has(form)) map.set(form, ref)
  }
}

function buildIndex(rows) {
  const captions = new Map()
  const keywords = new Map()
  for (const row of rows) {
    addIndexKey(captions, row.caption, row.ref)
    addIndexKey(captions, row.file_name, row.ref)
    addIndexKey(captions, String(row.caption || '').slice(0, 80), row.ref)
    addIndexKey(captions, String(row.caption || '').slice(0, 100), row.ref)
    const kw = String(row.keywords || '')
    addIndexKey(keywords, kw, row.ref)
    for (const word of kw.split(/\s+/)) addIndexKey(keywords, word, row.ref)
  }
  return { caption: captions, keyword: keywords }
}

function buildSearch(rows) {
  return rows.map((row) => {
    const hay = []
    const parts = []
    for (const s of [row.caption, row.keywords, row.file_name]) {
      const f = foldCaption(s)
      if (!f) continue
      const l = looseCaption(s)
      hay.push(f, ...(l && l !== f ? [l] : []))
      parts.push(s)
    }
    const tokens = [...new Set(splitDescTokens(parts.join(' ')))]
    return { hay, tokens, ref: row.ref }
  })
}

function matchDesc(desc, index, search) {
  const raw = String(desc || '').trim()
  if (!raw) return null
  const forms = [raw, foldCaption(raw), looseCaption(raw)]
  for (const map of [index.caption, index.keyword]) {
    for (const form of forms) {
      const exact = map.get(form)
      if (exact) return exact
    }
  }
  const needles = [...new Set(splitDescTokens(desc).map(looseCaption).filter(Boolean))]
  let best = null
  let bestLength = 0
  let bestCount = 0
  for (const row of search) {
    let longest = 0
    let count = 0
    for (const needle of needles) {
      let length = row.hay.some((hay) => hay.includes(needle)) ? needle.length : 0
      for (const token of row.tokens) {
        const t = looseCaption(token)
        if (t && (needle.includes(t) || t.includes(needle))) length = Math.max(length, Math.min(needle.length, t.length))
      }
      if (length) { longest = Math.max(longest, length); count++ }
    }
    if (longest > bestLength || (longest === bestLength && count > bestCount)) {
      best = row.ref
      bestLength = longest
      bestCount = count
    }
  }
  return best
}

function dshHome() {
  const env = String((process.env && process.env.DSH_MEME_HOME) || '').trim()
  return env || os.homedir()
}

function readMemeSettings() {
  try {
    const fp = path.join(dshHome(), '.dsh', 'dsh-expression.json')
    const raw = fs.readFileSync(fp, 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch (e) { return {} }
}

function candidatePackageDirs() {
  const home = dshHome()
  const out = []
  const push = (p) => { if (p && out.indexOf(p) < 0) out.push(p) }
  push(path.join(home, '.dsh', 'node_modules', 'dsh-meme'))
  let profs = []
  try { profs = fs.readdirSync(path.join(home, '.dsh', 'profiles')) } catch (e) { profs = [] }
  for (const name of profs) {
    const nm = path.join(home, '.dsh', 'profiles', name, 'node_modules')
    push(path.join(nm, 'dsh-meme'))
    let ids = []
    try { ids = fs.readdirSync(path.join(nm, '.pnpm')) } catch (e) { ids = [] }
    for (const d of ids) {
      if (d.indexOf('dsh-meme@') === 0) push(path.join(nm, '.pnpm', d, 'node_modules', 'dsh-meme'))
    }
  }
  return out
}

function scanPacks(dir) {
  const out = []
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const ent of ents) {
    const root = path.join(dir, ent.name)
    if (!fs.existsSync(path.join(root, 'index.db'))) continue
    let id = ent.name
    let name = ent.name
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
      if (mf && typeof mf.id === 'string' && mf.id) id = mf.id
      if (mf && typeof mf.name === 'string' && mf.name) name = mf.name
    } catch (e) {                               }
    out.push({ id, name, root })
  }
  return out
}

function collectPacks(settings) {
  const packs = []
  const seen = new Set()
  const addAll = (dir) => {
    for (const p of scanPacks(dir)) {
      if (seen.has(p.root)) continue
      seen.add(p.root)
      packs.push(p)
    }
  }
  const packsDir = String(settings.packsDir || '').trim() || path.join(dshHome(), '.dsh', 'meme-packs')
  const memeRoot = String(settings.memeRoot || '').trim()
  const packId = String(settings.packId || '').trim()

  if (memeRoot && fs.existsSync(path.join(memeRoot, 'index.db'))) {
    const hit = scanPacks(path.dirname(memeRoot)).filter((p) => p.root === memeRoot)
    for (const p of hit) { if (!seen.has(p.root)) { seen.add(p.root); packs.push(p) } }
  }
  if (packId) {
    const hit = scanPacks(packsDir).filter((p) => p.id === packId)
    for (const p of hit) { if (!seen.has(p.root)) { seen.add(p.root); packs.push(p) } }
  }

  for (const pkg of candidatePackageDirs()) addAll(path.join(pkg, 'memes'))

  addAll(packsDir)

  return packs
}

function loadRows(pack, mod) {
  const db = new mod.DatabaseSync(path.join(pack.root, 'index.db'), { readOnly: true })
  try {
    const stmt = db.prepare(SELECT_ROWS)
    const rows = stmt.all()
    const out = []
    for (const row of rows) {
      const rel = String((row && row.path) || '').trim()
      if (!rel) continue
      out.push({
        path: rel,
        tag: String(row.tag || ''),
        file_name: String(row.file_name || path.basename(rel)),
        caption: String(row.caption || ''),
        keywords: String(row.keywords || ''),
        ref: { root: pack.root, rel }
      })
    }
    return out
  } finally {
    try { db.close() } catch (e) {                    }
  }
}

export function createMemeGallery(opts) {
  const o = opts || {}
  const say = typeof o.log === 'function' ? o.log : () => {}
  let index = null
  let search = []
  let nextLoadAt = 0
  let warned = false

  function refresh() {
    const mod = sqlite()
    if (!mod) { index = null; search = []; nextLoadAt = Date.now() + ROWS_TTL_MS; return false }
    const settings = readMemeSettings()
    const packs = collectPacks(settings)
    const rows = []
    for (const pack of packs) {
      try {
        for (const row of loadRows(pack, mod)) rows.push(row)
      } catch (e) {

        if (!warned) { warned = true; say('[meme] 读不了图库索引 ' + pack.root + ': ' + ((e && e.message) || e)) }
      }
    }
    if (rows.length === 0) {
      index = null
      search = []
      nextLoadAt = Date.now() + ROWS_RETRY_MS
      return false
    }
    index = buildIndex(rows)
    search = buildSearch(rows)
    nextLoadAt = Date.now() + ROWS_TTL_MS
    return true
  }

  function ensure() {
    if (index && Date.now() < nextLoadAt) return true
    if (!index && Date.now() < nextLoadAt) return false
    return refresh()
  }

  function apply(text, pick) {
    const raw = String(text == null ? '' : text)
    const res = { rmd: raw, changed: false }

    if (!raw || raw.indexOf('表情') < 0) return res
    MEME_TEXT_RE.lastIndex = 0
    if (!MEME_TEXT_RE.test(raw)) { MEME_TEXT_RE.lastIndex = 0; return res }
    MEME_TEXT_RE.lastIndex = 0

    const has = ensure()
    const out = raw.replace(MEME_TEXT_RE, (whole, desc) => {
      const d = String(desc || '').trim()
      if (!d) return whole
      if (has) {
        const ref = matchDesc(d, index, search)
        if (ref) {
          try {
            const fp = path.join(ref.root, ref.rel)
            const st = fs.statSync(fp)
            if (st.isFile() && st.size > 0 && st.size <= MEME_MAX_BYTES) {
              const id = pick ? pick(fp, path.basename(ref.rel)) : ''
              if (id) return '![' + d + '](' + 'dshimg:' + id + ')'
            }
          } catch (e) {                    }
        }
      }

      return d
    })
    MEME_TEXT_RE.lastIndex = 0
    if (out !== raw) { res.rmd = out; res.changed = true }
    return res
  }

  function available() {
    return ensure()
  }

  return { apply, available, refresh }
}
