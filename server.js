const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT      = process.env.PORT || 3000

// Railway tem sistema de arquivos efêmero — usamos /tmp para dados salvos
// mas na primeira vez carregamos o data.json do repositório como seed
const SEED_FILE = path.join(__dirname, 'data.json')       // vem do GitHub
const SAVE_FILE = path.join('/tmp', 'clinica_data.json')  // persiste enquanto o container vive

// ── helpers ──────────────────────────────────────────────────────────────────
function readData () {
  // Tenta ler dados salvos em /tmp primeiro
  if (fs.existsSync(SAVE_FILE)) {
    try { return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) } catch {}
  }
  // Fallback: seed do repositório
  if (fs.existsSync(SEED_FILE)) {
    try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch {}
  }
  return null
}

function writeData (obj) {
  // Salva em /tmp (rápido) e também sobrescreve o seed para próximos boots
  const str = JSON.stringify(obj, null, 2)
  fs.writeFileSync(SAVE_FILE, str, 'utf8')
  try { fs.writeFileSync(SEED_FILE, str, 'utf8') } catch {}
}

function body (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 5e6) reject(new Error('too large')) })
    req.on('end',  () => { try { resolve(JSON.parse(raw)) } catch { reject(new Error('bad json')) } })
    req.on('error', reject)
  })
}

function send (res, status, obj) {
  const data = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type' : 'application/json',
    'Access-Control-Allow-Origin'  : '*',
    'Access-Control-Allow-Methods' : 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers' : 'Content-Type',
  })
  res.end(data)
}

function serveFile (res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' })
    res.end(content)
  } catch {
    send(res, 404, { error: 'not found' })
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (req.method === 'OPTIONS') { send(res, 204, {}); return }

  // Serve index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html')
    return
  }

  // Serve logo
  if (req.method === 'GET' && url.endsWith('.png')) {
    const imgPath = path.join(__dirname, path.basename(url))
    if (fs.existsSync(imgPath)) {
      const img = fs.readFileSync(imgPath)
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(img)
    } else {
      send(res, 404, { error: 'image not found' })
    }
    return
  }

  // GET /api/data
  if (req.method === 'GET' && url === '/api/data') {
    const d = readData()
    send(res, 200, d ? { ok: true, data: d } : { ok: false, data: null })
    return
  }

  // POST /api/data
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await body(req)
      writeData(payload)
      send(res, 200, { ok: true })
    } catch (e) {
      send(res, 400, { ok: false, error: e.message })
    }
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, () => console.log(`✅  PsicoTEAM rodando em http://localhost:${PORT}`))
