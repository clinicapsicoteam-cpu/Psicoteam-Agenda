const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT      = process.env.PORT || 3000
const DATA_FILE = path.join(__dirname, 'data.json')

// ── helpers ──────────────────────────────────────────────────────────────────
function readData () {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
  catch { return null }
}
function writeData (obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8')
}
function body (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 2e6) reject(new Error('too large')) })
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

// ── server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  // CORS preflight
  if (req.method === 'OPTIONS') { send(res, 204, {}); return }

  // Serve index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // GET /api/data  → retorna todos os dados
  if (req.method === 'GET' && url === '/api/data') {
    const d = readData()
    send(res, 200, d ? { ok: true, data: d } : { ok: false, data: null })
    return
  }

  // POST /api/data  → salva todos os dados
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

server.listen(PORT, () => console.log(`✅  Clínica rodando em http://localhost:${PORT}`))
