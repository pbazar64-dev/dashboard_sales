'use strict'

// Проверка параметров запроса дашборда. Всё, что приходит из браузера,
// считается недоверенным: значения проверяются по белым спискам и форматам
// до того, как попадут в фильтр запроса к Битрикс24.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_PERIOD_DAYS = 366 * 5

class ParamError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ParamError'
    this.status = 400
    this.code = 'INVALID_PARAMS'
  }
}

function parseDate(value, name) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ParamError(`Параметр ${name} должен быть датой в формате ГГГГ-ММ-ДД`)
  }
  const date = new Date(`${value}T00:00:00Z`)
  // Отсекаем несуществующие даты вроде 2026-02-31, которые Date «переносит».
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ParamError(`Параметр ${name} содержит несуществующую дату`)
  }
  return date
}

function parseDashboardParams(searchParams) {
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const fromDate = parseDate(from, 'from')
  const toDate = parseDate(to, 'to')
  if (fromDate > toDate) throw new ParamError('Начало периода позже его окончания')
  const days = (toDate - fromDate) / 86400000 + 1
  if (days > MAX_PERIOD_DAYS) throw new ParamError('Период не может быть длиннее 5 лет')

  const rawCategory = searchParams.get('categoryId') ?? '0'
  if (!/^\d{1,9}$/.test(rawCategory)) throw new ParamError('Некорректная воронка')
  const categoryId = Number(rawCategory)

  const owner = searchParams.get('owner') ?? 'all'
  if (owner !== 'all' && owner !== 'mine') throw new ParamError('Параметр owner: all или mine')

  return { from, to, categoryId, owner }
}

module.exports = { parseDashboardParams, ParamError }
