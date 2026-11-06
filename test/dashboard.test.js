'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildDealFilter, buildSummary, mapRecentDeals, stageEntityId } = require('../src/dashboard')
const { parseDashboardParams } = require('../src/params')
const { createVibeClient } = require('../src/vibe')

const STAGES = [
  { statusId: 'WON', name: 'Успех', sort: 60, semantics: 'S' },
  { statusId: 'NEW', name: 'Новая', sort: 10, semantics: null },
  { statusId: 'EXECUTING', name: 'В работе', sort: 40, semantics: null },
  { statusId: 'LOSE', name: 'Провал', sort: 70, semantics: 'F' },
]

test('stageEntityId: основная и дополнительная воронки', () => {
  assert.equal(stageEntityId(0), 'DEAL_STAGE')
  assert.equal(stageEntityId(3), 'DEAL_STAGE_3')
})

test('buildDealFilter: период включает обе границы, «мои» — по ответственному', () => {
  const params = { categoryId: 0, from: '2026-01-01', to: '2026-01-31', owner: 'all' }
  assert.deepEqual(buildDealFilter(params, '5'), {
    categoryId: 0,
    createdAt: { $gte: '2026-01-01T00:00:00', $lte: '2026-01-31T23:59:59' },
  })
  assert.equal(buildDealFilter({ ...params, owner: 'mine' }, '5').assignedById, 5)
  assert.throws(() => buildDealFilter({ ...params, owner: 'mine' }, null), /текущего пользователя/)
  assert.throws(() => buildDealFilter({ ...params, owner: 'mine' }, 'net_12'), /текущего пользователя/)
})

test('buildSummary: стадии по порядку, пустые стадии с нулём, KPI по семантике', () => {
  const summary = buildSummary(STAGES, {
    groups: [
      { stageId: 'NEW', currency: 'RUB', count: 5, aggregates: { amount: { sum: 1000 } } },
      { stageId: 'WON', currency: 'RUB', count: 2, aggregates: { amount: { sum: 600 } } },
      { stageId: 'LOSE', currency: 'RUB', count: 3, aggregates: { amount: { sum: 900 } } },
    ],
    meta: { truncated: false },
  })
  assert.deepEqual(summary.funnel.map((r) => r.stageId), ['NEW', 'EXECUTING', 'WON', 'LOSE'])
  assert.equal(summary.funnel[1].count, 0)
  assert.deepEqual(summary.funnel[1].money, [])
  assert.deepEqual(summary.kpi.openAmount, [{ currency: 'RUB', amount: 1000 }])
  assert.equal(summary.kpi.openCount, 5)
  assert.equal(summary.kpi.wonCount, 2)
  assert.deepEqual(summary.kpi.avgCheck, [{ currency: 'RUB', amount: 300 }])
  assert.equal(summary.kpi.lostCount, 3)
  assert.equal(summary.kpi.totalCount, 10)
  assert.equal(summary.kpi.conversion, 0.2)
  assert.equal(summary.multiCurrency, false)
  assert.equal(summary.truncated, false)
})

test('buildSummary: валюты не смешиваются, средний чек — по каждой валюте', () => {
  const summary = buildSummary(STAGES, {
    groups: [
      { stageId: 'WON', currency: 'RUB', count: 2, aggregates: { amount: { sum: 1000 } } },
      { stageId: 'WON', currency: 'USD', count: 1, aggregates: { amount: { sum: 50 } } },
    ],
    meta: { truncated: true },
  })
  assert.equal(summary.multiCurrency, true)
  assert.equal(summary.truncated, true)
  assert.equal(summary.kpi.wonCount, 3)
  assert.deepEqual(summary.kpi.avgCheck, [{ currency: 'RUB', amount: 500 }, { currency: 'USD', amount: 50 }])
})

test('buildSummary: группа удалённой стадии попадает в «Другие стадии»', () => {
  const summary = buildSummary(STAGES, {
    groups: [{ stageId: 'OLD', currency: 'RUB', count: 4, aggregates: { amount: { sum: 40 } } }],
  })
  const last = summary.funnel.at(-1)
  assert.equal(last.name, 'Другие стадии')
  assert.equal(last.count, 4)
  assert.equal(summary.kpi.totalCount, 4)
  assert.equal(summary.kpi.conversion, 0)
})

test('buildSummary: пустой период — конверсия не делится на ноль', () => {
  const summary = buildSummary(STAGES, { groups: [] })
  assert.equal(summary.kpi.totalCount, 0)
  assert.equal(summary.kpi.conversion, null)
  assert.deepEqual(summary.kpi.avgCheck, [])
})

test('mapRecentDeals: стадия и ответственный по справочникам', () => {
  const users = new Map([['7', 'Игорь Мельников']])
  const [deal, unknown] = mapRecentDeals([
    { id: '10', title: 'Поставка', amount: '1500.5', currency: 'RUB', stageId: 'WON', assignedById: 7, createdAt: '2026-01-02T10:00:00Z' },
    { id: 11, title: '', amount: null, currency: '', stageId: 'X', assignedById: 99 },
  ], STAGES, users)
  assert.equal(deal.id, 10)
  assert.equal(deal.amount, 1500.5)
  assert.equal(deal.stageName, 'Успех')
  assert.equal(deal.stageSemantics, 'S')
  assert.equal(deal.assignedName, 'Игорь Мельников')
  assert.equal(unknown.title, 'Сделка #11')
  assert.equal(unknown.stageName, 'X')
  assert.equal(unknown.assignedName, 'Сотрудник #99')
})

test('parseDashboardParams: корректный ввод', () => {
  const p = parseDashboardParams(new URLSearchParams('from=2026-01-01&to=2026-03-31&categoryId=2&owner=mine'))
  assert.deepEqual(p, { from: '2026-01-01', to: '2026-03-31', categoryId: 2, owner: 'mine' })
  const d = parseDashboardParams(new URLSearchParams('from=2026-01-01&to=2026-01-01'))
  assert.equal(d.categoryId, 0)
  assert.equal(d.owner, 'all')
})

test('parseDashboardParams: отклоняет некорректный ввод', () => {
  const bad = [
    '',
    'from=2026-01-01',
    'from=2026-02-31&to=2026-03-01',
    'from=01.01.2026&to=2026-01-31',
    'from=2026-02-01&to=2026-01-01',
    'from=2015-01-01&to=2026-01-01',
    'from=2026-01-01&to=2026-01-31&categoryId=-1',
    'from=2026-01-01&to=2026-01-31&categoryId=1;DROP',
    'from=2026-01-01&to=2026-01-31&owner=everyone',
  ]
  for (const qs of bad) {
    assert.throws(() => parseDashboardParams(new URLSearchParams(qs)), { status: 400 }, qs)
  }
})

test('vibe client: передаёт ключ приложения и токен сессии, разбирает ошибки', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/v1/deals')) {
      return new Response(JSON.stringify({ success: false, error: { code: 'SCOPE_DENIED', message: 'need crm' } }), { status: 403 })
    }
    return new Response(JSON.stringify({ success: true, data: { ok: 1 } }), { status: 200 })
  }
  const vibe = createVibeClient({ appKey: 'vibe_app_test', bearer: 'vibe_session_test', fetchImpl: fakeFetch })
  const res = await vibe.request('/me')
  assert.deepEqual(res.data, { ok: 1 })
  assert.equal(calls[0].url, 'https://vibecode.bitrix24.tech/v1/me')
  assert.equal(calls[0].init.headers['X-Api-Key'], 'vibe_app_test')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer vibe_session_test')
  await assert.rejects(vibe.request('/deals'), { status: 403, code: 'SCOPE_DENIED' })
})

test('vibe client: без ключа приложения — понятная ошибка конфигурации', () => {
  assert.throws(() => createVibeClient({ appKey: '', bearer: 'x' }), { code: 'APP_KEY_MISSING' })
})
