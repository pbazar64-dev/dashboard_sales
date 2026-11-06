'use strict'

// Интеграционные проверки HTTP-слоя в демо-режиме (без сети и ключей).

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.DEMO_MODE = '1'
const { server } = require('../server')

let base
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(() => server.close())

test('главная страница и заголовки безопасности', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await res.text(), /Дашборд воронки продаж/)
})

test('health и 404 для неизвестных путей (без обхода каталогов)', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await fetch(`${base}/assets/../server.js`)).status, 404)
  assert.equal((await fetch(`${base}/package.json`)).status, 404)
})

test('context: воронки и портал', async () => {
  const body = await (await fetch(`${base}/api/context`)).json()
  assert.equal(body.demo, true)
  assert.equal(body.portal, 'demo.bitrix24.ru')
  assert.deepEqual(body.categories.map((c) => c.id), [0, 1])
})

test('summary и deals за период; «мои» сужают выборку', async () => {
  const qs = 'from=2000-01-01&to=2099-12-31'
  const tooLong = await fetch(`${base}/api/summary?${qs}`)
  assert.equal(tooLong.status, 400)

  const today = new Date()
  const from = new Date(today.getTime() - 365 * 86400000).toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)
  const all = await (await fetch(`${base}/api/summary?from=${from}&to=${to}&categoryId=0`)).json()
  assert.ok(all.kpi.totalCount > 0)
  assert.equal(all.funnel.reduce((s, r) => s + r.count, 0), all.kpi.totalCount)

  const mine = await (await fetch(`${base}/api/summary?from=${from}&to=${to}&categoryId=0&owner=mine`)).json()
  assert.ok(mine.kpi.totalCount > 0 && mine.kpi.totalCount < all.kpi.totalCount)

  const deals = await (await fetch(`${base}/api/deals?from=${from}&to=${to}`)).json()
  assert.equal(deals.deals.length, 20)
  const dates = deals.deals.map((d) => d.createdAt)
  assert.deepEqual(dates, [...dates].sort().reverse())
  assert.ok(deals.deals.every((d) => d.assignedName && d.stageName))
})

test('неверные параметры — 400 с понятным сообщением', async () => {
  const res = await fetch(`${base}/api/summary?from=2026-05-01&to=2026-04-01`)
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, 'INVALID_PARAMS')
})

test('изменяющие методы запрещены', async () => {
  const res = await fetch(`${base}/api/summary`, { method: 'POST' })
  assert.equal(res.status, 405)
})
