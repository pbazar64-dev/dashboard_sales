'use strict';

(function () {
  // Весь вывод в DOM идёт через textContent/createElement — данные сделок
  // (названия, имена) никогда не вставляются как HTML.

  var STORAGE_KEY = 'sales-dashboard-filters-v1';
  var $ = function (id) { return document.getElementById(id); };

  var state = { portal: null, requestSeq: 0 };

  // ---------------------------------------------------------------------------
  // Даты и период

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { var r = new Date(d); r.setDate(r.getDate() + n); return r; }

  function presetRange(preset, today) {
    var y = today.getFullYear(), m = today.getMonth();
    switch (preset) {
      case 'this-month': return { from: new Date(y, m, 1), to: new Date(y, m + 1, 0) };
      case 'last-month': return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0) };
      case 'last-30': return { from: addDays(today, -29), to: today };
      case 'this-quarter': var q = Math.floor(m / 3) * 3; return { from: new Date(y, q, 1), to: new Date(y, q + 3, 0) };
      case 'this-year': return { from: new Date(y, 0, 1), to: new Date(y, 11, 31) };
      case 'last-365': return { from: addDays(today, -364), to: today };
      default: return null;
    }
  }

  function formatDate(value) {
    var d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00') : new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // Возвращает { from, to } в формате ГГГГ-ММ-ДД или { error }.
  function readPeriod() {
    var preset = $('period').value;
    if (preset !== 'custom') {
      var r = presetRange(preset, new Date());
      return { from: iso(r.from), to: iso(r.to) };
    }
    var from = $('date-from').value, to = $('date-to').value;
    $('date-from').removeAttribute('aria-invalid');
    $('date-to').removeAttribute('aria-invalid');
    if (!from || !to) {
      if (!from) $('date-from').setAttribute('aria-invalid', 'true');
      if (!to) $('date-to').setAttribute('aria-invalid', 'true');
      return { error: 'Укажите обе даты произвольного периода.' };
    }
    if (from > to) {
      $('date-from').setAttribute('aria-invalid', 'true');
      $('date-to').setAttribute('aria-invalid', 'true');
      return { error: 'Дата начала периода не может быть позже даты окончания.' };
    }
    var days = (new Date(to) - new Date(from)) / 86400000 + 1;
    if (days > 366 * 5) return { error: 'Период не может быть длиннее 5 лет.' };
    return { from: from, to: to };
  }

  function readFilters() {
    var period = readPeriod();
    if (period.error) return period;
    var owner = document.querySelector('input[name="owner"]:checked');
    return {
      categoryId: $('category').value || '0',
      from: period.from,
      to: period.to,
      owner: owner ? owner.value : 'all',
    };
  }

  function saveFilters() {
    try {
      var owner = document.querySelector('input[name="owner"]:checked');
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        categoryId: $('category').value, period: $('period').value,
        from: $('date-from').value, to: $('date-to').value, owner: owner ? owner.value : 'all',
      }));
    } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  function restoreFilters() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    if ([].some.call($('period').options, function (o) { return o.value === saved.period; })) $('period').value = saved.period;
    if (typeof saved.from === 'string') $('date-from').value = saved.from;
    if (typeof saved.to === 'string') $('date-to').value = saved.to;
    if ([].some.call($('category').options, function (o) { return o.value === saved.categoryId; })) $('category').value = saved.categoryId;
    var radio = document.querySelector('input[name="owner"][value="' + (saved.owner === 'mine' ? 'mine' : 'all') + '"]');
    if (radio) radio.checked = true;
  }

  // ---------------------------------------------------------------------------
  // Форматирование

  function formatMoney(amount, currency) {
    try {
      if (/^[A-Z]{3}$/.test(currency)) {
        return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: currency, maximumFractionDigits: 0 }).format(amount);
      }
    } catch (e) { /* неизвестная валюта — ниже общий формат */ }
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(amount) + (currency && currency !== '—' ? ' ' + currency : '');
  }

  function formatInt(n) { return new Intl.NumberFormat('ru-RU').format(n); }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Список сумм в разных валютах: первая — крупно, остальные — строкой ниже.
  function fillMoney(node, list) {
    node.textContent = '';
    if (!list || list.length === 0) { node.textContent = formatMoney(0, 'RUB'); return; }
    node.appendChild(document.createTextNode(formatMoney(list[0].amount, list[0].currency)));
    if (list.length > 1) {
      node.appendChild(el('span', 'extra', list.slice(1).map(function (m) { return '+ ' + formatMoney(m.amount, m.currency); }).join('  ')));
    }
  }

  function moneyText(list) {
    if (!list || list.length === 0) return '—';
    return list.map(function (m) { return formatMoney(m.amount, m.currency); }).join(' + ');
  }

  // ---------------------------------------------------------------------------
  // API

  function ApiError(status, code, message) { this.status = status; this.code = code; this.message = message; }

  function api(path, params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    // Относительный адрес: приложение может жить по пути внутри поддомена.
    return fetch('api/' + path + qs, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) {
            var err = body && body.error;
            throw new ApiError(res.status, err && err.code, (err && err.message) || 'Сервис временно недоступен (' + res.status + ')');
          }
          return body;
        });
      }, function () {
        throw new ApiError(0, 'NETWORK', 'Нет связи с сервером приложения. Проверьте подключение и обновите страницу.');
      });
  }

  function showNotice(id, message, isError, retry) {
    var box = $(id);
    box.textContent = '';
    box.className = 'notice' + (isError ? ' error' : '');
    box.appendChild(document.createTextNode(message));
    if (retry) {
      var b = el('button', 'btn', 'Повторить');
      b.type = 'button';
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    box.hidden = false;
  }
  function hideNotice(id) { $(id).hidden = true; }

  // ---------------------------------------------------------------------------
  // Рендер

  function renderKpis(kpi, filters) {
    fillMoney(document.querySelector('[data-kpi="open"]'), kpi.openAmount);
    document.querySelector('[data-kpi-note="open"]').textContent =
      formatInt(kpi.openCount) + ' ' + plural(kpi.openCount, 'сделка', 'сделки', 'сделок') + ' в работе';
    document.querySelector('[data-kpi="won"]').textContent = formatInt(kpi.wonCount);
    var wonNote = kpi.wonAmount.length ? 'на ' + moneyText(kpi.wonAmount) : 'за выбранный период';
    document.querySelector('[data-kpi-note="won"]').textContent = wonNote;
    var avg = document.querySelector('[data-kpi="avg"]');
    if (kpi.avgCheck.length) fillMoney(avg, kpi.avgCheck); else avg.textContent = '—';
    document.querySelector('[data-kpi="conv"]').textContent =
      kpi.conversion === null ? '—' : (kpi.conversion * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' %';
    document.querySelector('[data-kpi-note="conv"]').textContent =
      formatInt(kpi.wonCount) + ' из ' + formatInt(kpi.totalCount) + ', проиграно ' + formatInt(kpi.lostCount);
  }

  function semanticsClass(s) { return s === 'S' ? 'won' : s === 'F' ? 'lost' : ''; }
  function semanticsLabel(s) { return s === 'S' ? 'успешная стадия' : s === 'F' ? 'провальная стадия' : 'в работе'; }

  function renderFunnel(summary) {
    var root = $('funnel');
    root.textContent = '';
    var rows = summary.funnel;
    if (!rows.length) { root.appendChild(el('p', 'empty', 'В воронке нет стадий.')); return; }

    var head = el('div', 'funnel-row funnel-head');
    head.appendChild(el('span', null, 'Стадия'));
    head.appendChild(el('span', null, 'Доля сделок'));
    head.appendChild(el('span', 'num', 'Сделок'));
    head.appendChild(el('span', 'num', 'Сумма'));
    root.appendChild(head);

    var max = rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0);
    var total = summary.kpi.totalCount;
    rows.forEach(function (r) {
      var row = el('div', 'funnel-row');
      var name = el('div', 'stage-name');
      name.appendChild(el('i', 'dot ' + semanticsClass(r.semantics)));
      name.appendChild(el('span', null, r.name));
      name.title = r.name;
      var track = el('div', 'track');
      var bar = el('div', 'bar ' + semanticsClass(r.semantics));
      bar.style.width = max ? (r.count / max * 100).toFixed(2) + '%' : '0';
      if (!r.count) bar.style.minWidth = '0';
      track.appendChild(bar);
      var money = el('div', 'num money-cell money-lines');
      if (r.money.length) r.money.forEach(function (m) { money.appendChild(el('span', null, formatMoney(m.amount, m.currency))); });
      else money.textContent = '—';
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(el('div', 'num', formatInt(r.count)));
      row.appendChild(money);
      var share = total ? (r.count / total * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' %' : '—';
      attachTooltip(row, r.name, [
        semanticsLabel(r.semantics),
        'Сделок: ' + formatInt(r.count) + ' (' + share + ')',
        'Сумма: ' + moneyText(r.money),
      ]);
      root.appendChild(row);
    });

    var totalRow = el('div', 'funnel-row funnel-total');
    totalRow.appendChild(el('span', null, 'Итого'));
    totalRow.appendChild(el('span', 'spacer'));
    totalRow.appendChild(el('div', 'num', formatInt(total)));
    var sum = {};
    rows.forEach(function (r) { r.money.forEach(function (m) { sum[m.currency] = (sum[m.currency] || 0) + m.amount; }); });
    var totalMoney = el('div', 'num money-cell money-lines');
    var keys = Object.keys(sum);
    if (keys.length) keys.forEach(function (c) { totalMoney.appendChild(el('span', null, formatMoney(sum[c], c))); });
    else totalMoney.textContent = '—';
    totalRow.appendChild(totalMoney);
    root.appendChild(totalRow);

    $('funnel-hint').textContent = total ? formatInt(total) + ' ' + plural(total, 'сделка', 'сделки', 'сделок') + ' за период' : '';
    if (!total) root.appendChild(el('p', 'empty', 'За выбранный период сделок нет — попробуйте расширить период или сменить воронку.'));

    var notes = [];
    if (summary.truncated) notes.push('Под фильтр попало больше 5000 сделок: суммы посчитаны по первым 5000 (ограничение API агрегации). Сузьте период для точных сумм.');
    if (summary.multiCurrency) notes.push('Сделки в разных валютах: суммы показаны отдельно по каждой валюте, без пересчёта по курсу.');
    if (notes.length) showNotice('summary-notice', notes.join(' '), false); else hideNotice('summary-notice');
  }

  function openDeal(id) {
    // Домен портала берётся только из доверенного ответа сервера (GET /v1/me),
    // а не из URL страницы. Навигация верхнего окна — только по клику.
    if (!state.portal || !/^[a-z0-9.-]+$/i.test(state.portal)) return;
    var url = 'https://' + state.portal + '/crm/deal/details/' + encodeURIComponent(id) + '/';
    try { window.top.location.href = url; } catch (e) { window.open(url, '_blank', 'noopener'); }
  }

  function renderDeals(deals) {
    var body = $('deals-body');
    body.textContent = '';
    if (!deals.length) {
      var tr = el('tr');
      var td = el('td', 'empty', 'За выбранный период сделок нет.');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    deals.forEach(function (d) {
      var tr = el('tr');
      var titleCell = el('td');
      if (state.portal) {
        var link = el('button', 'deal-link', d.title);
        link.type = 'button';
        link.title = 'Открыть сделку в Битрикс24';
        link.addEventListener('click', function () { openDeal(d.id); });
        titleCell.appendChild(link);
      } else {
        titleCell.textContent = d.title;
      }
      tr.appendChild(titleCell);
      tr.appendChild(el('td', 'num', formatMoney(d.amount, d.currency)));
      var stageCell = el('td');
      stageCell.appendChild(el('span', 'badge ' + semanticsClass(d.stageSemantics), d.stageName));
      tr.appendChild(stageCell);
      tr.appendChild(el('td', null, d.assignedName));
      tr.appendChild(el('td', 'num', formatDate(d.createdAt)));
      body.appendChild(tr);
    });
  }

  function setLoading() {
    $('funnel').textContent = '';
    $('funnel').appendChild(el('p', 'loading', 'Загружаем данные…'));
    $('deals-body').textContent = '';
    var tr = el('tr'); var td = el('td', 'loading', 'Загружаем сделки…'); td.colSpan = 5; tr.appendChild(td);
    $('deals-body').appendChild(tr);
    ['open', 'won', 'avg', 'conv'].forEach(function (k) { document.querySelector('[data-kpi="' + k + '"]').textContent = '…'; });
  }

  // ---------------------------------------------------------------------------
  // Тултип для строк воронки

  var tooltip = $('tooltip');
  function attachTooltip(node, title, lines) {
    node.addEventListener('mousemove', function (e) {
      tooltip.textContent = '';
      tooltip.appendChild(el('strong', null, title));
      lines.forEach(function (l) { tooltip.appendChild(el('div', null, l)); });
      tooltip.hidden = false;
      var x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      var y = Math.min(e.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
      tooltip.style.left = Math.max(8, x) + 'px';
      tooltip.style.top = Math.max(8, y) + 'px';
    });
    node.addEventListener('mouseleave', function () { tooltip.hidden = true; });
  }

  // ---------------------------------------------------------------------------
  // Загрузка

  function describePeriod(f) {
    return 'Сделки, созданные с ' + formatDate(f.from) + ' по ' + formatDate(f.to) +
      ' · ' + ($('category').selectedOptions[0] ? $('category').selectedOptions[0].textContent : '') +
      ' · ' + (f.owner === 'mine' ? 'только мои' : 'все доступные мне');
  }

  function load() {
    var filters = readFilters();
    if (filters.error) {
      $('form-error').textContent = filters.error;
      $('form-error').hidden = false;
      return;
    }
    $('form-error').hidden = true;
    saveFilters();
    $('period-caption').textContent = describePeriod(filters);

    // Ответы на устаревшие запросы (пользователь успел сменить фильтр) отбрасываем.
    var seq = ++state.requestSeq;
    var params = { categoryId: filters.categoryId, from: filters.from, to: filters.to, owner: filters.owner };
    setLoading();
    hideNotice('summary-notice');
    hideNotice('deals-notice');
    $('apply').disabled = true;

    var summaryP = api('summary', params).then(function (summary) {
      if (seq !== state.requestSeq) return;
      renderKpis(summary.kpi, filters);
      renderFunnel(summary);
    }, function (err) {
      if (seq !== state.requestSeq) return;
      $('funnel').textContent = '';
      ['open', 'won', 'avg', 'conv'].forEach(function (k) { document.querySelector('[data-kpi="' + k + '"]').textContent = '—'; });
      showNotice('summary-notice', err.message, true, err.status === 401 ? null : load);
    });

    var dealsP = api('deals', params).then(function (res) {
      if (seq !== state.requestSeq) return;
      renderDeals(res.deals);
    }, function (err) {
      if (seq !== state.requestSeq) return;
      $('deals-body').textContent = '';
      showNotice('deals-notice', err.message, true, err.status === 401 ? null : load);
    });

    Promise.all([summaryP, dealsP]).then(function () {
      if (seq === state.requestSeq) $('apply').disabled = false;
      reportHeight();
    });
  }

  function init() {
    api('context').then(function (ctx) {
      state.portal = ctx.portal;
      $('demo-badge').hidden = !ctx.demo;
      var who = ctx.user && ctx.user.name ? ctx.user.name : 'текущий пользователь';
      $('subtitle').textContent = 'Аналитика по сделкам CRM' + (ctx.portal ? ' · ' + ctx.portal : '') + ' · ' + who;
      var select = $('category');
      select.textContent = '';
      ctx.categories.forEach(function (c) {
        var o = el('option', null, c.name);
        o.value = String(c.id);
        select.appendChild(o);
      });
      restoreFilters();
      $('custom-range').hidden = $('period').value !== 'custom';
      load();
    }, function (err) {
      $('subtitle').textContent = 'Не удалось загрузить дашборд';
      showNotice('summary-notice', err.message, true, err.status === 401 ? null : init);
    });
  }

  $('period').addEventListener('change', function () {
    var custom = $('period').value === 'custom';
    $('custom-range').hidden = !custom;
    if (custom && (!$('date-from').value || !$('date-to').value)) {
      var r = presetRange('this-month', new Date());
      $('date-from').value = iso(r.from);
      $('date-to').value = iso(r.to);
    }
    if (!custom) load();
  });
  $('category').addEventListener('change', load);
  [].forEach.call(document.querySelectorAll('input[name="owner"]'), function (r) { r.addEventListener('change', load); });
  $('filters').addEventListener('submit', function (e) { e.preventDefault(); load(); });

  // ---------------------------------------------------------------------------
  // Авто-высота iframe внутри Битрикс24 (сообщение vibe:resize родителю).

  var lastHeight = 0;
  function reportHeight() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h === lastHeight || window.parent === window) return;
    lastHeight = h;
    window.parent.postMessage({ type: 'vibe:resize', height: h }, '*');
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);

  init();
})();
