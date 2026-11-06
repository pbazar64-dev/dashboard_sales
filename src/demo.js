'use strict'

// Демо-режим (DEMO_MODE=1): подменяет API Вайбкод генератором правдоподобных
// данных. Нужен для локального запуска и проверки интерфейса без портала.
// В демо-режиме не выполняется ни одного сетевого запроса, ключи не нужны.

const STAGES = {
  0: [
    { statusId: 'NEW', name: 'Новая', sort: 10, semantics: null, color: '#39A8EF' },
    { statusId: 'PREPARATION', name: 'Подготовка документов', sort: 20, semantics: null, color: '#2FC6F6' },
    { statusId: 'PREPAYMENT_INVOICE', name: 'Счёт на предоплату', sort: 30, semantics: null, color: '#55D0E0' },
    { statusId: 'EXECUTING', name: 'В работе', sort: 40, semantics: null, color: '#47E4C2' },
    { statusId: 'FINAL_INVOICE', name: 'Финальный счёт', sort: 50, semantics: null, color: '#FFA900' },
    { statusId: 'WON', name: 'Сделка успешна', sort: 60, semantics: 'S', color: '#7BD500' },
    { statusId: 'LOSE', name: 'Сделка провалена', sort: 70, semantics: 'F', color: '#FF5752' },
  ],
  1: [
    { statusId: 'C1:NEW', name: 'Заявка', sort: 10, semantics: null },
    { statusId: 'C1:EXECUTING', name: 'Переговоры', sort: 20, semantics: null },
    { statusId: 'C1:WON', name: 'Контракт подписан', sort: 30, semantics: 'S' },
    { statusId: 'C1:LOSE', name: 'Отказ', sort: 40, semantics: 'F' },
  ],
}

const USERS = [
  { id: 1, name: 'Анна', lastName: 'Ковалёва' },
  { id: 7, name: 'Игорь', lastName: 'Мельников' },
  { id: 12, name: 'Ольга', lastName: 'Сидоренко' },
  { id: 15, name: 'Дмитрий', lastName: 'Орлов' },
]

const TITLES = ['Поставка оборудования', 'Внедрение CRM', 'Годовая подписка', 'Монтаж и наладка',
  'Консалтинг', 'Лицензии на 50 мест', 'Сервисный контракт', 'Пилотный проект', 'Обучение персонала',
  'Расширение лицензий', 'Разработка интеграции', 'Аудит процессов']

// Детерминированный генератор, чтобы демо выглядело одинаково при каждом запуске.
function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateDeals(now = new Date()) {
  const rand = mulberry32(2024)
  const deals = []
  for (let i = 0; i < 420; i++) {
    const categoryId = rand() < 0.8 ? 0 : 1
    const stages = STAGES[categoryId]
    // Перекос к ранним стадиям — как в настоящей воронке.
    const stage = stages[Math.min(stages.length - 1, Math.floor(rand() ** 1.6 * stages.length))]
    const created = new Date(now.getTime() - Math.floor(rand() * 400) * 86400000 - Math.floor(rand() * 86400000))
    const currency = rand() < 0.93 ? 'RUB' : 'USD'
    const base = currency === 'RUB' ? 20000 + rand() * 900000 : 500 + rand() * 12000
    deals.push({
      id: 1000 + i,
      title: `${TITLES[Math.floor(rand() * TITLES.length)]} — ${['ООО «Север»', 'АО «Вектор»', 'ИП Громов', 'ООО «Лидер»', 'ЗАО «Альфа-Трейд»'][Math.floor(rand() * 5)]}`,
      amount: Math.round(base / 100) * 100,
      currency,
      stageId: stage.statusId,
      categoryId,
      assignedById: USERS[Math.floor(rand() * USERS.length)].id,
      createdAt: created.toISOString(),
    })
  }
  return deals
}

function matches(deal, filter) {
  if (filter.categoryId !== undefined && deal.categoryId !== filter.categoryId) return false
  if (filter.assignedById !== undefined && deal.assignedById !== filter.assignedById) return false
  if (filter.createdAt) {
    const created = deal.createdAt.slice(0, 19)
    if (filter.createdAt.$gte && created < filter.createdAt.$gte) return false
    if (filter.createdAt.$lte && created > filter.createdAt.$lte) return false
  }
  return true
}

function createDemoClient({ userId = '7' } = {}) {
  const deals = generateDeals()

  async function request(path, { query = {}, body } = {}) {
    if (path === '/me') {
      return { success: true, data: { portal: 'demo.bitrix24.ru', currentUser: { bitrixUserId: userId } } }
    }
    if (path === '/deal-categories') {
      return { success: true, data: [{ id: 1, name: 'Корпоративные продажи', sort: 200 }] }
    }
    if (path === '/statuses') {
      const { entityId } = JSON.parse(query.filter)
      const id = entityId === 'DEAL_STAGE' ? 0 : Number(entityId.replace('DEAL_STAGE_', ''))
      return { success: true, data: STAGES[id] ?? [] }
    }
    if (path === '/deals/aggregate') {
      const groups = new Map()
      for (const deal of deals.filter((d) => matches(d, body.filter))) {
        const key = `${deal.stageId}|${deal.currency}`
        const g = groups.get(key) ?? { stageId: deal.stageId, currency: deal.currency, count: 0, aggregates: { amount: { sum: 0 } } }
        g.count += 1
        g.aggregates.amount.sum += deal.amount
        groups.set(key, g)
      }
      const list = [...groups.values()]
      return { success: true, data: { count: list.reduce((s, g) => s + g.count, 0), groups: list, meta: { truncated: false } } }
    }
    if (path === '/deals') {
      const filter = JSON.parse(query.filter)
      const list = deals.filter((d) => matches(d, filter))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Number(query.limit) || 50)
      return { success: true, data: list }
    }
    if (path === '/users') {
      return { success: true, data: USERS }
    }
    throw Object.assign(new Error(`Demo: unknown path ${path}`), { status: 404, code: 'NOT_FOUND' })
  }

  return { request }
}

module.exports = { createDemoClient }
