#!/usr/bin/env node
'use strict'

// Деплой дашборда на сервер Black Hole платформы Битрикс24 Вайбкод.
//
// Использование:
//   VIBE_API_KEY=vibe_api_… SERVER_ID=<uuid> node scripts/deploy.js
//
// VIBE_API_KEY — личный ключ (скоуп vibe:infra) владельца сервера. Нужен
// только для выкладки и в приложение НЕ передаётся.
// Ключ приложения VIBE_APP_KEY задаётся секретом в карточке приложения.
// Если секреты для портала не включены, его можно передать при деплое:
//   VIBE_APP_KEY=vibe_app_… VIBE_API_KEY=… SERVER_ID=… node scripts/deploy.js
// Ключи читаются только из переменных окружения и никуда не выводятся.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BASE = process.env.VIBE_URL || 'https://vibecode.bitrix24.tech'
const API_KEY = process.env.VIBE_API_KEY
const SERVER_ID = process.env.SERVER_ID
const ROOT = path.join(__dirname, '..')
const FILES = ['server.js', 'package.json', 'src', 'public']

function fail(message) {
  console.error(`Ошибка: ${message}`)
  process.exit(1)
}

async function call(method, urlPath, body) {
  const res = await fetch(`${BASE}/v1${urlPath}`, {
    method,
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json || json.success === false) {
    const err = json?.error
    fail(`${method} ${urlPath} → ${res.status} ${err?.code ?? ''} ${err?.message ?? ''}`)
  }
  return json
}

async function main() {
  if (!API_KEY) fail('задайте VIBE_API_KEY (личный ключ со скоупом vibe:infra)')
  if (!SERVER_ID || !/^[0-9a-f-]{36}$/i.test(SERVER_ID)) fail('задайте SERVER_ID (UUID сервера из раздела Black Hole)')

  const server = await call('GET', `/infra/servers/${SERVER_ID}`)
  console.log(`Сервер: ${server.data.name ?? SERVER_ID} (${server.data.kind ?? 'STANDALONE'}, ${server.data.status})`)

  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b24dash-')), 'app.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', ROOT, ...FILES])
  const content = fs.readFileSync(archive).toString('base64')
  console.log(`Архив: ${(fs.statSync(archive).size / 1024).toFixed(1)} КБ`)

  const env = { NODE_ENV: 'production' }
  if (process.env.VIBE_APP_KEY) env.VIBE_APP_KEY = process.env.VIBE_APP_KEY

  const result = await call('POST', `/infra/servers/${SERVER_ID}/deploy`, {
    source: { content },
    runtime: 'node24',
    start: 'cd /opt/app && node server.js',
    port: 3000,
    healthPath: '/health',
    env,
    displayName: 'Дашборд воронки продаж',
    description: 'Сводка по стадиям воронки, ключевые показатели и последние сделки CRM с фильтром по периоду.',
  })

  for (const w of result.data?.warnings ?? result.warnings ?? []) {
    console.warn(`Предупреждение: ${typeof w === 'string' ? w : w.message ?? JSON.stringify(w)}`)
  }
  const url = result.data?.appUrl ?? server.data.appUrl
  console.log(`Готово. Адрес приложения: ${url ?? '(см. карточку сервера)'}`)
}

main().catch((err) => fail(err.message))
