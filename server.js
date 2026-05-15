const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')
const SAVE_FILE = path.join('/tmp', 'clinica_data.json')

// ── helpers ──────────────────────────────────────────────────────────────────
function readData() {
  // 1. Tenta dados salvos em /tmp
  if (fs.existsSync(SAVE_FILE)) {
    try {
      const raw = fs.readFileSync(SAVE_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && (parsed.agendas || parsed.pacientes)) {
        console.log('✅ Dados carregados de /tmp')
        return parsed
      }
    } catch(e) {
      console.warn('⚠️ /tmp corrompido, usando seed:', e.message)
    }
  }
  // 2. Fallback: seed do repositório
  if (fs.existsSync(SEED_FILE)) {
    try {
      const raw = fs.readFileSync(SEED_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      console.log('✅ Dados carregados do seed (data.json)')
      return parsed
    } catch(e) {
      console.error('❌ Seed corrompido:', e.message)
    }
  }
  console.log('⚠️ Nenhum dado encontrado, retornando estrutura vazia')
  return { agendas: [], pacientes: [], currentAgendaId: null, nextPatId: 1, nextAgendaId: 1 }
}

function writeData(obj) {
  const str = JSON.stringify(obj, null, 2)
  try { fs.writeFileSync(SAVE_FILE, str, 'utf8') } catch(e) { console.warn('Erro ao salvar /tmp:', e.message) }
  try { fs.writeFileSync(SEED_FILE, str, 'utf8') } catch(e) { console.warn('Erro ao salvar seed:', e.message) }
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 10e6) reject(new Error('too large')) })
    req.on('end',  () => { try { resolve(JSON.parse(raw)) } catch { reject(new Error('bad json')) } })
    req.on('error', reject)
  })
}

function send(res, status, obj) {
  const data = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type' : 'application/json',
    'Access-Control-Allow-Origin'  : '*',
    'Access-Control-Allow-Methods' : 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers' : 'Content-Type',
  })
  res.end(data)
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' })
    res.end(content)
  } catch(e) {
    console.error('Erro ao servir arquivo:', filePath, e.message)
    send(res, 404, { error: 'not found' })
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  console.log(`${req.method} ${url}`)

  if (req.method === 'OPTIONS') { send(res, 204, {}); return }

  // Serve index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html')
    return
  }

  // Serve imagens (png, jpg, ico)
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg)$/i.test(url)) {
    const imgName = path.basename(url)
    // Tenta nome exato, depois sem espaços, depois busca no diretório
    const candidates = [
      path.join(__dirname, imgName),
      path.join(__dirname, decodeURIComponent(imgName)),
    ]
    // Também busca qualquer .png no diretório se for a logo
    const files = fs.readdirSync(__dirname)
    const pngFile = files.find(f => f.toLowerCase().endsWith('.png'))
    if (pngFile) candidates.push(path.join(__dirname, pngFile))

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const img = fs.readFileSync(candidate)
          const ext = path.extname(candidate).toLowerCase()
          const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon' : `image/${ext.slice(1)}`
          res.writeHead(200, { 'Content-Type': mime })
          res.end(img)
          return
        } catch(e) {}
      }
    }
    send(res, 404, { error: 'image not found' })
    return
  }

  // GET /api/data
  if (req.method === 'GET' && url === '/api/data') {
    try {
      const d = readData()
      send(res, 200, { ok: true, data: d })
    } catch(e) {
      console.error('Erro ao ler dados:', e)
      send(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // POST /api/data
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await body(req)
      writeData(payload)
      send(res, 200, { ok: true })
    } catch(e) {
      console.error('Erro ao salvar dados:', e)
      send(res, 400, { ok: false, error: e.message })
    }
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`✅ PsicoTEAM rodando em http://localhost:${PORT}`)
  // Pré-carrega os dados para detectar erros cedo
  try {
    const d = readData()
    console.log(`📊 ${d.agendas?.length||0} agendas, ${d.pacientes?.length||0} pacientes carregados`)
  } catch(e) {
    console.error('❌ Erro ao pré-carregar dados:', e.message)
  }
})
