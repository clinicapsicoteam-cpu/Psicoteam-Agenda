const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')
const SAVE_FILE = path.join('/tmp', 'clinica_data.json')

function readData() {
  // Always read seed first to get current version
  let seed = null
  try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) {}

  // Try saved /tmp data
  if (fs.existsSync(SAVE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'))
      // If saved data is OLDER than seed (version check), discard it
      const savedVer = saved._version || 0
      const seedVer  = seed?._version  || 0
      if (savedVer < seedVer) {
        console.log(`🔄 Seed version (${seedVer}) > saved version (${savedVer}). Using seed (reset).`)
        // Delete old /tmp so it won't interfere again
        try { fs.unlinkSync(SAVE_FILE) } catch(e) {}
        return seed
      }
      console.log('✅ Using saved /tmp data (version', savedVer, ')')
      return saved
    } catch(e) {
      console.warn('⚠️ /tmp corrupt, using seed:', e.message)
    }
  }

  if (seed) { console.log('✅ Using seed data.json'); return seed }
  return { agendas:[], pacientes:[], currentAgendaId:1, nextPatId:1, nextAgendaId:1 }
}

function writeData(obj) {
  const str = JSON.stringify(obj, null, 2)
  try { fs.writeFileSync(SAVE_FILE, str, 'utf8') } catch(e) { console.error('write /tmp error:', e) }
  // Also update seed so next cold boot keeps latest data
  try { fs.writeFileSync(SEED_FILE, str, 'utf8') } catch(e) {}
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
    req.on('error', reject)
  })
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Serve index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      })
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
    return
  }

  // Serve images
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f =>
      f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png')
    )
    if (found) {
      try {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(fs.readFileSync(path.join(__dirname, found)))
        return
      } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data
  if (req.method === 'GET' && url === '/api/data') {
    json(res, 200, { ok: true, data: readData() })
    return
  }

  // POST /api/data
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      writeData(payload)
      json(res, 200, { ok: true })
    } catch(e) {
      json(res, 400, { ok: false, error: e.message })
    }
    return
  }

  json(res, 404, { ok: false, error: 'not found' })

}).listen(PORT, () => {
  const d = readData()
  console.log(`✅ PsicoTEAM porta ${PORT} | ${d.agendas?.length||0} agendas | ${d.pacientes?.length||0} pacientes | versão ${d._version||'—'}`)
})
