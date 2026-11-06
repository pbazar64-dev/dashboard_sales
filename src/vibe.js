'use strict'

// Клиент API платформы Вайбкод (https://vibecode.bitrix24.tech/v1).
//
// Все запросы идут от лица текущего пользователя: в X-Api-Key — ключ
// OAuth-приложения (vibe_app_…) из переменной окружения, в Authorization —
// токен сессии, который Gateway передал приложению в X-Vibe-Authorization.
// Токены никогда не логируются и не возвращаются браузеру.

const VIBE_BASE_URL = 'https://vibecode.bitrix24.tech'

// Gateway ждёт заголовки ответа приложения не дольше 14 секунд, поэтому
// таймаут одного запроса и паузы повторов держим заметно ниже этого окна.
const REQUEST_TIMEOUT_MS = 11000
const MAX_RETRY_WAIT_S = 3

class VibeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'VibeError'
    this.status = status
    this.code = code
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createVibeClient({ appKey, bearer, fetchImpl = fetch, baseUrl = VIBE_BASE_URL }) {
  if (!appKey) throw new VibeError(500, 'APP_KEY_MISSING', 'Не задан секрет VIBE_APP_KEY')

  async function request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(`/v1${path}`, baseUrl)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
    }

    const headers = { 'X-Api-Key': appKey, Accept: 'application/json' }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    // Повторяем только отказы 429/503, которые по документации означают,
    // что запрос до Битрикс24 не дошёл (QUEUE_OVERFLOW, RATE_LIMITED и т. п.).
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        throw new VibeError(504, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
          timeout ? 'Битрикс24 не ответил вовремя' : 'Платформа Вайбкод недоступна')
      }

      const json = await res.json().catch(() => null)

      if ((res.status === 429 || res.status === 503) && attempt < 1) {
        const advised = Number(res.headers.get('retry-after') ?? json?.error?.retryAfter)
        const wait = Number.isFinite(advised) && advised > 0 ? Math.min(advised, MAX_RETRY_WAIT_S) : 1
        await sleep(wait * 1000 + Math.random() * 300)
        continue
      }

      if (!res.ok || !json || json.success === false) {
        const code = json?.error?.code ?? `HTTP_${res.status}`
        const message = json?.error?.userMessage ?? json?.error?.message ?? `Запрос отклонён (${res.status})`
        throw new VibeError(res.status || 502, code, message)
      }
      return json
    }
  }

  return { request }
}

module.exports = { createVibeClient, VibeError, VIBE_BASE_URL }
