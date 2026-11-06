'use strict'

// Бизнес-логика дашборда: какие запросы отправить в API Вайбкод и как
// собрать из ответов сводку по воронке, ключевые показатели и список
// последних сделок. Функции build*/map* — чистые и покрыты тестами.

const RECENT_DEALS_LIMIT = 20

function stageEntityId(categoryId) {
  return categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`
}

// Фильтр сделок: воронка + период создания + (опционально) только мои.
// Дата без часового пояса трактуется Битрикс24 в поясе пользователя, от
// имени которого идёт запрос, — то есть в поясе того, кто открыл дашборд.
function buildDealFilter({ categoryId, from, to, owner }, currentUserId) {
  const filter = {
    categoryId,
    createdAt: { $gte: `${from}T00:00:00`, $lte: `${to}T23:59:59` },
  }
  if (owner === 'mine') {
    if (!/^\d+$/.test(String(currentUserId ?? ''))) {
      const err = new Error('Не удалось определить текущего пользователя для фильтра «Мои сделки»')
      err.status = 400
      err.code = 'NO_CURRENT_USER'
      throw err
    }
    filter.assignedById = Number(currentUserId)
  }
  return filter
}

function normalizeSemantics(value) {
  return value === 'S' || value === 'F' ? value : 'P'
}

// Деньги храним как { валюта: сумма }: Битрикс24 не приводит суммы сделок
// к одной валюте, поэтому складывать разные валюты нельзя.
function addMoney(target, currency, amount) {
  const key = currency || '—'
  const value = Number(amount) || 0
  target[key] = (target[key] ?? 0) + value
}

function moneyList(map) {
  return Object.entries(map)
    .filter(([, amount]) => amount !== 0)
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
}

function buildSummary(stages, aggregate) {
  const ordered = [...stages].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const rows = new Map()
  for (const stage of ordered) {
    rows.set(stage.statusId, {
      stageId: stage.statusId,
      name: stage.name,
      semantics: normalizeSemantics(stage.semantics),
      color: typeof stage.color === 'string' && /^#[0-9a-f]{6}$/i.test(stage.color) ? stage.color : null,
      count: 0,
      money: {},
    })
  }

  // Группы, чья стадия отсутствует в справочнике (стадию удалили), не теряем —
  // собираем в отдельную строку, чтобы итоги сходились.
  let orphan = null
  for (const group of aggregate.groups ?? []) {
    let row = rows.get(group.stageId)
    if (!row) {
      orphan ??= { stageId: null, name: 'Другие стадии', semantics: 'P', color: null, count: 0, money: {} }
      row = orphan
    }
    row.count += Number(group.count) || 0
    addMoney(row.money, group.currency, group.aggregates?.amount?.sum)
  }

  const funnel = [...rows.values()]
  if (orphan) funnel.push(orphan)

  const open = { count: 0, money: {} }
  const won = { count: 0, money: {}, countByCurrency: {} }
  let lostCount = 0
  let totalCount = 0
  for (const row of funnel) {
    totalCount += row.count
    if (row.semantics === 'S') {
      won.count += row.count
      for (const [currency, amount] of Object.entries(row.money)) addMoney(won.money, currency, amount)
    } else if (row.semantics === 'F') {
      lostCount += row.count
    } else {
      open.count += row.count
      for (const [currency, amount] of Object.entries(row.money)) addMoney(open.money, currency, amount)
    }
  }
  // Средний чек = сумма выигранных / число выигранных, отдельно по каждой валюте.
  for (const group of aggregate.groups ?? []) {
    const row = rows.get(group.stageId)
    if (row && row.semantics === 'S') {
      addMoney(won.countByCurrency, group.currency, group.count)
    }
  }
  const avgCheck = {}
  for (const [currency, sum] of Object.entries(won.money)) {
    const count = won.countByCurrency[currency]
    if (count) avgCheck[currency] = sum / count
  }

  const truncated = Boolean(aggregate.meta?.truncated || aggregate.truncated)
  const currencies = new Set(funnel.flatMap((row) => Object.keys(row.money)))

  return {
    funnel: funnel.map((row) => ({ ...row, money: moneyList(row.money) })),
    kpi: {
      openAmount: moneyList(open.money),
      openCount: open.count,
      wonCount: won.count,
      wonAmount: moneyList(won.money),
      avgCheck: moneyList(avgCheck),
      lostCount,
      totalCount,
      conversion: totalCount ? won.count / totalCount : null,
    },
    multiCurrency: currencies.size > 1,
    truncated,
  }
}

function formatUserName(user) {
  const name = [user.name, user.lastName].filter(Boolean).join(' ').trim()
  return name || `Сотрудник #${user.id}`
}

function mapRecentDeals(deals, stages, usersById) {
  const stageById = new Map(stages.map((s) => [s.statusId, s]))
  return deals.map((deal) => {
    const stage = stageById.get(deal.stageId)
    const assignedId = deal.assignedById != null ? String(deal.assignedById) : null
    return {
      id: Number(deal.id),
      title: deal.title || `Сделка #${deal.id}`,
      amount: Number(deal.amount) || 0,
      currency: deal.currency || '',
      stageName: stage?.name ?? deal.stageId ?? '—',
      stageSemantics: normalizeSemantics(stage?.semantics),
      assignedName: assignedId ? (usersById.get(assignedId) ?? `Сотрудник #${assignedId}`) : '—',
      createdAt: deal.createdAt ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// Запросы к API Вайбкод

async function fetchStages(vibe, categoryId) {
  const res = await vibe.request('/statuses', {
    query: { filter: JSON.stringify({ entityId: stageEntityId(categoryId) }), limit: 200 },
  })
  return Array.isArray(res.data) ? res.data : []
}

async function fetchContext(vibe) {
  const [me, categories] = await Promise.all([
    vibe.request('/me'),
    vibe.request('/deal-categories', { query: { limit: 200 } }).catch(() => ({ data: [] })),
  ])
  const list = (Array.isArray(categories.data) ? categories.data : [])
    .map((c) => ({ id: Number(c.id), name: String(c.name ?? `Воронка ${c.id}`), sort: c.sort ?? 0 }))
    .filter((c) => Number.isInteger(c.id) && c.id >= 0)
  // Основная воронка (id 0) в списке направлений есть не всегда.
  if (!list.some((c) => c.id === 0)) list.unshift({ id: 0, name: 'Основная воронка', sort: -1 })
  list.sort((a, b) => a.sort - b.sort)

  const userId = me.data?.currentUser?.bitrixUserId
  return {
    portal: typeof me.data?.portal === 'string' ? me.data.portal : null,
    currentUserId: /^\d+$/.test(String(userId ?? '')) ? String(userId) : null,
    categories: list.map(({ id, name }) => ({ id, name })),
  }
}

async function fetchSummary(vibe, params, currentUserId) {
  const filter = buildDealFilter(params, currentUserId)
  const [stages, aggregate] = await Promise.all([
    fetchStages(vibe, params.categoryId),
    vibe.request('/deals/aggregate', {
      method: 'POST',
      body: {
        aggregate: [{ field: 'amount', function: 'sum' }],
        filter,
        groupBy: ['stageId', 'currency'],
      },
    }),
  ])
  return buildSummary(stages, aggregate.data ?? {})
}

async function fetchUserNames(vibe, ids) {
  const names = new Map()
  if (ids.length === 0) return names
  try {
    const res = await vibe.request('/users', {
      query: {
        filter: JSON.stringify({ id: { $in: ids.map(Number) } }),
        select: 'id,name,lastName',
        limit: 50,
      },
    })
    for (const user of res.data ?? []) names.set(String(user.id), formatUserName(user))
  } catch {
    // Без скоупа user или при сбое показываем «Сотрудник #ID» — список сделок
    // от этого не должен ломаться.
  }
  return names
}

async function fetchRecentDeals(vibe, params, currentUserId) {
  const filter = buildDealFilter(params, currentUserId)
  const [stages, deals] = await Promise.all([
    fetchStages(vibe, params.categoryId),
    vibe.request('/deals', {
      query: {
        filter: JSON.stringify(filter),
        select: 'id,title,amount,currency,stageId,assignedById,createdAt',
        sort: '-createdAt',
        limit: RECENT_DEALS_LIMIT,
        withTotal: 'false',
      },
    }),
  ])
  const list = Array.isArray(deals.data) ? deals.data.slice(0, RECENT_DEALS_LIMIT) : []
  const ids = [...new Set(list.map((d) => d.assignedById).filter((id) => /^\d+$/.test(String(id ?? ''))).map(String))]
  const users = await fetchUserNames(vibe, ids)
  return { deals: mapRecentDeals(list, stages, users) }
}

module.exports = {
  RECENT_DEALS_LIMIT,
  stageEntityId,
  buildDealFilter,
  buildSummary,
  mapRecentDeals,
  formatUserName,
  fetchContext,
  fetchSummary,
  fetchRecentDeals,
}
