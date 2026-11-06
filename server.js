'use strict'

// Дашборд воронки продаж для Битрикс24 (платформа Битрикс24 Вайбкод).
//
// Сервер — тонкий BFF (Backend-for-Frontend) без внешних зависимостей:
//  • отдаёт статический интерфейс из ./public;
//  • на /api/* берёт токен сессии пользователя из заголовка
//    X-Vibe-Authorization (его ставит Gateway платформы) и ходит в API
//    Вайбкод от имени этого пользователя;
//  • токен и ключ приложения никогда не попадают в браузер и в логи.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { createVibeClient } = require('./src/vibe')
const { createDemoClient } = require('./src/demo')
const { parseDashboardParams, ParamError } = require('./src/params')
const { fetchContext, fetchSummary, fetchRecentDeals } = require('./src/dashboard')

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const DEMO_MODE = process.env.DEMO_MODE === '1'
const APP_KEY = process.env.VIBE_APP_KEY || ''

// ---------------------------------------------------------------------------
// Статика: белый список файлов, загруженных в память при старте.

const PUBLIC_DIR = path.join(__dirname, 'public')
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/assets/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/assets/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/favicon.ico': ['icon.svg', 'image/svg+xml'],
}
const staticCache = new Map()
for (const [route, [file, type]] of Object.entries(STATIC_FILES)) {
  staticCache.set(route, { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type })
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // frame-ancestors не ограничиваем: приложение открывается в iframe портала
  // (домен портала заранее неизвестен) и в обёртке vibecode.bitrix24.tech.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
}

// ---------------------------------------------------------------------------
// Кэш контекста пользователя (портал, ID, воронки) — чтобы не дёргать
// /v1/me на каждый запрос. Ключ — SHA-256 от токена, сам токен не хранится.

const CONTEXT_TTL_MS = 5 * 60 * 1000
const CONTEXT_CACHE_MAX = 500
const contextCache = new Map()

function tokenKey(bearer) {
  return crypto.createHash('sha256').update(bearer).digest('hex')
}

async function getContext(vibe, bearer) {
  const key = bearer ? tokenKey(bearer) : 'demo'
  const cached = contextCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const value = await fetchContext(vibe)
  if (contextCache.size >= CONTEXT_CACHE_MAX) contextCache.delete(contextCache.keys().next().value)
  contextCache.set(key, { value, expires: Date.now() + CONTEXT_TTL_MS })
  return value
}

// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, err) {
  if (err instanceof ParamError || err.code === 'NO_CURRENT_USER') {
    return sendJson(res, 400, { error: { code: err.code, message: err.message } })
  }
  const status = Number(err.status) || 500
  if (status === 401) {
    // По одному 401 нельзя отличить истёкшую сессию Gateway от отсутствия
    // доступа, поэтому формулировка нейтральная (см. документацию app-runtime).
    return sendJson(res, 401, {
      error: {
        code: 'AUTHORIZATION_REQUIRED',
        message: 'Нужно заново войти или выдать приложению доступ: откройте дашборд из левого меню Битрикс24.',
      },
    })
  }
  if (status === 403) {
    return sendJson(res, 403, {
      error: { code: err.code || 'FORBIDDEN', message: `Недостаточно прав: ${err.message}` },
    })
  }
  if (status === 429) {
    return sendJson(res, 429, {
      error: { code: err.code, message: 'Битрикс24 перегружен запросами. Повторите через несколько секунд.' },
    })
  }
  // Внутренние подробности наружу не отдаём; код ошибки платформы безопасен.
  const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR'
  const message = status >= 500 && !err.code ? 'Внутренняя ошибка приложения' : err.message
  return sendJson(res, status >= 400 && status < 600 ? status : 500, { error: { code, message } })
}

function readBearer(req) {
  const raw = req.headers['x-vibe-authorization']
  if (typeof raw !== 'string') return null
  const match = /^Bearer\s+(\S+)$/.exec(raw.trim())
  return match ? match[1] : null
}

function readUserName(req) {
  const encoded = req.headers['x-vibe-user-name-encoded']
  if (typeof encoded !== 'string' || !encoded) return null
  try {
    return decodeURIComponent(encoded).slice(0, 200)
  } catch {
    return null
  }
}

async function handleApi(req, res, url) {
  let vibe
  let bearer = null
  if (DEMO_MODE) {
    vibe = createDemoClient()
  } else {
    bearer = readBearer(req)
    if (!bearer) {
      const err = new Error('no session')
      err.status = 401
      throw err
    }
    vibe = createVibeClient({ appKey: APP_KEY, bearer })
  }

  if (url.pathname === '/api/context') {
    const ctx = await getContext(vibe, bearer)
    return sendJson(res, 200, {
      demo: DEMO_MODE,
      portal: ctx.portal,
      user: { name: DEMO_MODE ? 'Игорь Мельников' : readUserName(req) },
      categories: ctx.categories,
    })
  }

  if (url.pathname === '/api/summary' || url.pathname === '/api/deals') {
    const params = parseDashboardParams(url.searchParams)
    let currentUserId = null
    if (params.owner === 'mine') {
      const ctx = await getContext(vibe, bearer)
      currentUserId = ctx.currentUserId
    }
    const data = url.pathname === '/api/summary'
      ? await fetchSummary(vibe, params, currentUserId)
      : await fetchRecentDeals(vibe, params, currentUserId)
    return sendJson(res, 200, data)
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Неизвестный метод API' } })
}

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const requestId = String(req.headers['x-vibe-request-id'] ?? '').slice(0, 40)
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return sendJson(res, 400, { error: { code: 'BAD_URL', message: 'Некорректный адрес' } })
  }

  res.on('finish', () => {
    // В лог — только метод, путь без параметров, статус и ID запроса Gateway.
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms ${requestId}`)
  })

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается' } })
    }
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true })
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)

    const file = staticCache.get(url.pathname)
    if (!file) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Страница не найдена' } })
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'Cache-Control': url.pathname === '/' || url.pathname === '/index.html' ? 'no-cache' : 'public, max-age=300',
    })
    return res.end(req.method === 'HEAD' ? undefined : file.body)
  } catch (err) {
    if (!(err instanceof ParamError) && !(err.status && err.status < 500)) {
      console.error(`error ${url.pathname} ${err.code ?? ''} ${err.message} ${requestId}`)
    }
    if (!res.headersSent) sendError(res, err)
  }
})

if (require.main === module) {
  if (!DEMO_MODE && !APP_KEY) {
    console.warn('VIBE_APP_KEY не задан: API дашборда будет отвечать ошибкой. Задайте секрет в карточке приложения или запустите с DEMO_MODE=1.')
  }
  server.listen(PORT, HOST, () => {
    console.log(`Sales dashboard listening on ${HOST}:${PORT}${DEMO_MODE ? ' (demo mode)' : ''}`)
  })
}

module.exports = { server }
