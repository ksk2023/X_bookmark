// 管理页主逻辑。所有数据都走 background 的 RPC，UI 是纯客户端渲染。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => (window.XBUtil ? XBUtil.escapeHtml : (x) => x)(s);
  const fmtDate = (ms) => ms ? (window.XBUtil ? XBUtil.fmtDate(ms) : new Date(ms).toLocaleString()) : '';
  const fmtRel = (ms) => ms ? (window.XBUtil ? XBUtil.fmtRel(ms) : '') : '';
  let lastFullSyncState = '';
  const LIST_BATCH_SIZE = 40;
  let listRenderToken = 0;
  let listObserver = null;
  let listPageState = null;
  let timeStatsToken = 0;

  let state = {
    view: 'all',
    activeCatId: null,
    activeAuthorId: null,
    search: '',
    categories: [],
    bookmarks: [],
    history: [],
    historyConfig: null,
    timeFilter: { mode: 'all', year: '', halfYear: '', halfPart: '1', month: '', day: '', from: '', to: '' },
    timeGroup: 'day',
    timeSource: 'tweet',
    timeVizCollapsed: false,
    selected: new Set(),
    pendingBatches: [],
  };
  let dashAuthorsToken = 0;
  let dashAuthorsCache = [];

  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    setTimeout(() => { el.className = 'toast hidden'; }, 2600);
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (r) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(r || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // AI 端点是用户自填的任意地址，manifest 没法穷举。
  // 所以用 optional_host_permissions + 运行时按 origin 请求，保证任意 OpenAI 兼容端点（含本地 Ollama/LM Studio）都能跨域调用。
  function originPattern(url) {
    try {
      const u = new URL(url);
      return u.origin + '/*';
    } catch (e) { return null; }
  }
  async function ensureHostPermission(url) {
    const pattern = originPattern(url);
    if (!pattern) return { ok: false, error: 'Base URL 无法解析' };
    if (!chrome.permissions) return { ok: true, already: true, note: 'permissions API 不可用（按需权限已隐含授予）' };
    try {
      const has = await new Promise((res) => chrome.permissions.contains({ origins: [pattern] }, res));
      if (has) return { ok: true, already: true };
      const granted = await new Promise((res) => chrome.permissions.request({ origins: [pattern] }, res));
      return { ok: !!granted };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function decodeTweetTime(t) {
    if (!t) return null;
    const d = new Date(t);
    if (isNaN(d)) return null;
    return d.getTime();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateKeyFromDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayInput() {
    return dateKeyFromDate(new Date());
  }

  function monthInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function parseDateInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d.getTime();
  }

  function parseMonthInput(value) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return { from: new Date(y, mo, 1).getTime(), to: new Date(y, mo + 1, 1).getTime(), year: y };
  }

  function ensureTimeDefaults() {
    const now = new Date();
    if (state.timeFilter.mode === 'year' && !state.timeFilter.year) state.timeFilter.year = String(now.getFullYear());
    if (state.timeFilter.mode === 'half') {
      if (!state.timeFilter.halfYear) state.timeFilter.halfYear = String(now.getFullYear());
      if (!state.timeFilter.halfPart) state.timeFilter.halfPart = now.getMonth() < 6 ? '1' : '2';
    }
    if (state.timeFilter.mode === 'month' && !state.timeFilter.month) state.timeFilter.month = monthInput(now);
    if (state.timeFilter.mode === 'day' && !state.timeFilter.day) state.timeFilter.day = todayInput();
  }

  function setTimePanelVisible(show) {
    const panel = $('timePanel');
    if (panel) panel.classList.toggle('hidden', !show);
  }

  function syncTimeInputs() {
    if (!$('timeMode')) return;
    ensureTimeDefaults();
    $('timeMode').value = state.timeFilter.mode;
    if ($('timeGroup')) $('timeGroup').value = state.timeGroup || 'auto';
    if ($('timeSource')) $('timeSource').value = normalizeTimeSource(state.timeSource);
    $('timeYear').value = state.timeFilter.year;
    if ($('timeHalfYear')) $('timeHalfYear').value = state.timeFilter.halfYear || '';
    if ($('timeHalfPart')) $('timeHalfPart').value = state.timeFilter.halfPart || '1';
    $('timeMonth').value = state.timeFilter.month;
    $('timeDay').value = state.timeFilter.day;
    $('timeFrom').value = state.timeFilter.from;
    $('timeTo').value = state.timeFilter.to;
    qsa('[data-time-mode]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.timeMode !== state.timeFilter.mode);
    });
  }

  function readTimeInputs() {
    state.timeFilter.mode = $('timeMode').value || 'all';
    if ($('timeGroup')) state.timeGroup = $('timeGroup').value || 'auto';
    if ($('timeSource')) state.timeSource = normalizeTimeSource($('timeSource').value);
    state.timeFilter.year = $('timeYear').value.trim();
    state.timeFilter.halfYear = $('timeHalfYear') ? $('timeHalfYear').value.trim() : '';
    state.timeFilter.halfPart = $('timeHalfPart') ? ($('timeHalfPart').value || '1') : '1';
    state.timeFilter.month = $('timeMonth').value;
    state.timeFilter.day = $('timeDay').value;
    state.timeFilter.from = $('timeFrom').value;
    state.timeFilter.to = $('timeTo').value;
  }

  function getTimeQuery() {
    const f = state.timeFilter;
    if (f.mode === 'year') {
      const y = Number(f.year);
      if (!Number.isFinite(y) || y < 2006) return {};
      return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
    }
    if (f.mode === 'half') {
      const y = Number(f.halfYear);
      if (!Number.isFinite(y) || y < 2006) return {};
      const mo = f.halfPart === '2' ? 6 : 0;
      return { from: new Date(y, mo, 1).getTime(), to: new Date(y, mo + 6, 1).getTime() };
    }
    if (f.mode === 'month') {
      const r = parseMonthInput(f.month);
      return r ? { from: r.from, to: r.to } : {};
    }
    if (f.mode === 'day') {
      const from = parseDateInput(f.day);
      return from ? { from, to: from + 24 * 60 * 60 * 1000 } : {};
    }
    if (f.mode === 'range') {
      const q = {};
      const from = parseDateInput(f.from);
      const to = parseDateInput(f.to);
      if (from) q.from = from;
      if (to) q.to = to + 24 * 60 * 60 * 1000;
      return q;
    }
    return {};
  }

  // 0.4.28: 用户点击年份导航时设置覆盖年份，强制刷新热力图
  let heatYearOverride = null;
  function setHeatmapYearOverride(year) {
    heatYearOverride = year || null;
    const lbl = $('heatYearLabel');
    if (lbl) lbl.textContent = year;
    const baseQuery = getBaseBookmarkQuery();
    baseQuery.heatmapYear = year;
    refreshTimeStats(baseQuery);
  }

  function getHeatmapYear() {
    if (heatYearOverride) return heatYearOverride;
    const f = state.timeFilter;
    if (f.mode === 'year' && Number(f.year)) return Number(f.year);
    if (f.mode === 'half' && Number(f.halfYear)) return Number(f.halfYear);
    if (f.mode === 'month') {
      const r = parseMonthInput(f.month);
      if (r) return r.year;
    }
    if (f.mode === 'day' && f.day) {
      const t = parseDateInput(f.day);
      if (t) return new Date(t).getFullYear();
    }
    if (f.mode === 'range' && f.from) {
      const t = parseDateInput(f.from);
      if (t) return new Date(t).getFullYear();
    }
    return null;
  }

  function updateHeatYearLabel() {
    const stats = state._lastTimeStats;
    const y = stats && stats.heatmapYear ? stats.heatmapYear : new Date().getFullYear();
    const lbl = $('heatYearLabel');
    if (lbl) lbl.textContent = y;
  }

  const TIME_DAY_MS = 24 * 60 * 60 * 1000;

  function clearTimeFocus() {
    state.timeFocus = null;
    state.timeVizCollapsed = false;
    syncTimeVizCompact();
  }

  function normalizeTimeSource(source) {
    return source === 'tweet' || source === 'tweetTime' ? 'tweet' : 'captured';
  }

  function timeSourceLabel(source) {
    return normalizeTimeSource(source) === 'tweet' ? '推文发布时间' : '收藏记录时间（本地入库）';
  }

  function timeSourceHelp(stats, source) {
    source = normalizeTimeSource(source);
    if (source === 'tweet') return '当前默认按推文发布时间统计和筛选；它能把历史同步内容分散开，但不代表你实际收藏这条推文的日期。';
    if ((stats.total || 0) > 20 && (stats.activeDays || 0) <= 1) {
      return '历史全量同步只能保存插件入库时间，所以旧书签可能集中在同步当天；切回“推文发布时间”可按内容发布时间分散查看。';
    }
    return '收藏记录时间是插件第一次保存到本地的时间；它不等同于 X 原始收藏日期。';
  }

  function getTimeGroupBy() {
    const selected = $('timeGroup') ? $('timeGroup').value : state.timeGroup;
    state.timeGroup = selected || 'auto';
    const manual = ['year', 'half', 'biweek', 'month', 'week', 'day'].includes(state.timeGroup) ? state.timeGroup : '';
    if (manual) return manual;
    if (['year', 'half', 'month', 'day'].includes(state.timeFilter.mode)) return state.timeFilter.mode;
    return 'auto';
  }

  function timeUnitName(groupBy) {
    const map = { year: '年', half: '半年', biweek: '半月', month: '月', week: '周', day: '日' };
    return map[groupBy] || '时间段';
  }

  function getViewQuery() {
    const q = {};
    if (state.view === 'uncategorized') q.categoryId = 'uncategorized';
    else if (state.view === 'removed') q.removedOnly = true;
    else if (state.view === 'cat') q.categoryId = state.activeCatId;
    if (state.search) q.search = state.search;
    return q;
  }

  function getBaseBookmarkQuery() {
    const q = getViewQuery();
    q.timeSource = normalizeTimeSource(state.timeSource);
    Object.assign(q, getTimeQuery());
    return q;
  }

  function queryWithTimeBucket(baseQuery, bucket) {
    const q = Object.assign({}, baseQuery || {});
    const from = bucket ? Number(bucket.from) : NaN;
    const to = bucket ? Number(bucket.to) : NaN;
    if (Number.isFinite(from)) q.from = from;
    if (Number.isFinite(to)) q.to = to;
    return q;
  }

  function shouldAutoOpenList() {
    const q = getTimeQuery();
    const span = q.from && q.to ? q.to - q.from : 0;
    return state.timeFilter.mode === 'day' || (span > 0 && span <= TIME_DAY_MS);
  }

  function heatLevel(count, max) {
    if (!count) return 0;
    const ratio = count / Math.max(1, max);
    if (ratio >= 0.7) return 4;
    if (ratio >= 0.4) return 3;
    if (ratio >= 0.15) return 2;
    return 1;
  }

  function normalizeTimeBucket(bucket, groupBy) {
    if (!bucket) return null;
    const from = Number(bucket.from);
    const to = Number(bucket.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return {
      key: String(bucket.key || ''),
      label: String(bucket.label || bucket.key || ''),
      count: Number(bucket.count) || 0,
      from,
      to,
      groupBy: groupBy || bucket.groupBy || 'auto',
    };
  }

  function bucketDomKey(bucket) {
    if (!bucket) return '';
    return (bucket.groupBy || 'auto') + ':' + bucket.key;
  }

  function isActiveBucket(bucket) {
    return !!(state.timeFocus && bucket && bucketDomKey(state.timeFocus) === bucketDomKey(bucket));
  }

  function setActiveBucketMarks() {
    const active = state.timeFocus ? bucketDomKey(state.timeFocus) : '';
    qsa('[data-time-bucket]').forEach((el) => {
      el.classList.toggle('active', !!active && el.dataset.timeBucket === active);
    });
  }

  function syncTimeVizCompact() {
    const panel = $('timePanel');
    if (!panel) return;
    const compact = !!state.timeVizCollapsed;
    panel.classList.toggle('compact', compact);

    const btn = $('timeVizToggle');
    if (btn) btn.textContent = compact ? '展开统计' : '收起统计';

    const line = $('timeFocusLine');
    if (!line) return;
    if (state.timeFocus) {
      const activeKey = bucketDomKey(state.timeFocus);
      const matched = (state.timeBuckets || []).find((b) => bucketDomKey(b) === activeKey);
      const count = matched && Number(matched.count) ? (' · ' + matched.count + ' 条') : '';
      line.innerHTML = '<button class="backBtn" id="backToAll">← 返回全部</button> <span>当前查看：' + esc(state.timeFocus.label || state.timeFocus.key || '选中时间段') + count + '</span>';
      const back = $('backToAll');
      if (back) back.addEventListener('click', () => {
        clearTimeFocus();
        state.timeFilter = { mode: 'all', year: '', halfYear: '', halfPart: '1', month: '', day: '', from: '', to: '' };
        syncTimeInputs();
        refreshList();
      });
    } else {
      line.textContent = compact ? '统计已收起。' : '';
    }
  }

  function applyTimeBucketFocus(rawBucket, groupBy) {
    const bucket = normalizeTimeBucket(rawBucket, groupBy);
    if (!bucket) return;
    state.timeFocus = bucket;
    state.timeVizCollapsed = true;
    setActiveBucketMarks();
    syncTimeVizCompact();
    const q = queryWithTimeBucket(getBaseBookmarkQuery(), bucket);
    startPagedList(q, bucket.label);
    requestAnimationFrame(() => {
      const list = $('list');
      if (list) list.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function showTimeOverviewPrompt(baseQuery) {
    listRenderToken++;
    listPageState = null;
    stopListObserver();
    state.bookmarks = [];
    $('viewTitle').textContent = viewTitle() + ' · 时间概览';
    $('viewCount').textContent = '';
    $('list').innerHTML = '';
    $('empty').classList.add('hidden');
    $('batchBar').classList.add('hidden');

    const box = document.createElement('div');
    box.className = 'timePrompt';

    const title = document.createElement('h3');
    title.textContent = '先按时间段浏览';
    const tip = document.createElement('p');
    tip.className = 'muted';
    tip.textContent = '上方会按当前时间依据和展示粒度聚合；默认按推文发布时间逐日拆分。点击一个格子或统计行，只加载那一段里的书签，避免一次性渲染几千张卡片。';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '仍然显示当前范围首批书签';
    loadBtn.addEventListener('click', () => {
      clearTimeFocus();
      startPagedList(baseQuery, '当前范围');
    });
    actions.appendChild(loadBtn);

    box.appendChild(title);
    box.appendChild(tip);
    box.appendChild(actions);
    $('list').appendChild(box);
  }

  async function refreshTimeStats(query) {
    if (!$('timePanel') || $('timePanel').classList.contains('hidden')) return;
    const token = ++timeStatsToken;
    $('timeSummary').textContent = '统计中...';
    const r = await send('xb/bookmarks/timeStats', {
      query: Object.assign({}, query, {
        groupBy: getTimeGroupBy(),
        heatmapYear: getHeatmapYear(),
      }),
    });
    if (token !== timeStatsToken) return;
    if (!r.ok) {
      $('timeSummary').textContent = '统计失败：' + (r.error || '未知错误');
      $('heatmapGrid').innerHTML = '';
      $('timeBuckets').innerHTML = '';
      if ($('trendSvg')) $('trendSvg').innerHTML = '';
      if ($('trendPeak')) $('trendPeak').innerHTML = '';
      return;
    }
    renderTimeStats(r.data || {});
  }

  function renderTimeStats(stats) {
    const group = stats.groupBy || 'year';
    const unit = timeUnitName(group);
    const source = normalizeTimeSource(stats.timeSource || state.timeSource);
    state.timeSource = source;
    const buckets = stats.buckets || [];
    state.timeBuckets = buckets.map((b) => normalizeTimeBucket(b, group)).filter(Boolean);
    const maxBucket = stats.maxBucket ? (' · 峰值 ' + (stats.maxBucket.label || stats.maxBucket.key) + '：' + stats.maxBucket.count + ' 条') : '';
    const untimed = stats.untimed ? (' · ' + stats.untimed + ' 条缺少时间') : '';
    const groupMode = getTimeGroupBy();
    const groupText = groupMode === 'auto' ? ('自动选择：按' + unit + '聚合') : ('按' + unit + '聚合');
    $('timeSummary').textContent = '共 ' + (stats.total || 0) + ' 条 · 时间依据：' + timeSourceLabel(source) + ' · ' + groupText + ' · ' + buckets.length + ' 个时间段' + maxBucket + untimed;
    $('heatmapTitle').textContent = (source === 'tweet' ? '推文发布时间热力图' : '收藏记录热力图') + '（按' + unit + '）';
    if ($('timeSourceHint')) $('timeSourceHint').textContent = timeSourceHelp(stats, source);
    state._lastTimeStats = stats;
    renderHeatmap(stats);
    try {
      renderTrendChart(stats);
    } catch (e) {
      const svg = $('trendSvg');
      if (svg) {
        svg.innerHTML = '';
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', '12');
        t.setAttribute('y', '24');
        t.setAttribute('fill', 'var(--muted)');
        t.setAttribute('font-size', '12');
        t.textContent = '趋势图渲染异常：' + (e && e.message ? e.message : String(e));
        svg.appendChild(t);
      }
      if ($('trendPeak')) $('trendPeak').textContent = '';
    }
    renderTimeBuckets(stats);
    setActiveBucketMarks();
    syncTimeVizCompact();
    syncDashboardTopHeight();
  }

  function makeDayBucket(date, count) {
    const key = dateKeyFromDate(date);
    const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return { key, label: key, count: count || 0, from, to: from + TIME_DAY_MS, groupBy: 'day' };
  }

  function heatmapColors() {
    return ['#f5f5f5', '#ffb3ba', '#ff6b6b', '#e63946', '#a4161a'];
  }

  function heatmapModeLabel(group) {
    const map = { week: '按周热力图', month: '按月热力图', biweek: '按半月热力图', half: '按半年热力图', year: '按年热力图' };
    return map[group] || '热力图';
  }

    // 0.4.22: GitHub 风格热力图，7 行（周一到周日）× 每周一列；
  // 没有收藏的日子渲染为 .empty（不显色但保留位置），
  // 同时返回每月起始列、统计信息，供标签与侧栏使用。
  function renderDayHeatmap(stats, grid) {
    const year = Number(stats.heatmapYear) || new Date().getFullYear();
    let daily = Array.isArray(stats.daily) ? stats.daily : [];
    if (!daily.length && stats.groupBy === 'day' && Array.isArray(stats.buckets)) {
      daily = stats.buckets
        .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(String(b.key || '')))
        .map((b) => ({ date: String(b.key), count: Number(b.count) || 0 }));
    }
    const counts = new Map(daily.map((d) => [d.date, Number(d.count) || 0]));
    const max = Math.max(1, ...daily.map((d) => Number(d.count) || 0));
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    const leading = (start.getDay() + 6) % 7; // Mon=0 ... Sun=6
    const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const monthCols = [];
    let lastMonth = -1;
    let total = 0;
    let activeDays = 0;
    let peak = { count: 0, key: '' };

    grid.innerHTML = '';
    grid.className = 'heatmapGrid heatmap-svg';
    grid.style.cssText = [
      'display:block',
      'width:max-content',
      'min-width:850px',
      'height:136px',
      'min-height:136px',
      'padding:0',
      'margin:0',
    ].join(';') + ';';
    grid.dataset.renderedYear = String(year);
    // Build a flat list of cells: leading spacers, then 365/366 day cells.
    const allCells = [];
    for (let i = 0; i < leading; i++) allCells.push(null); // spacer
    const d = new Date(start);
    for (; d < end; d.setDate(d.getDate() + 1)) {
      const day = new Date(d);
      const key = dateKeyFromDate(day);
      const count = counts.get(key) || 0;
      allCells.push({ key, count, day, month: day.getMonth(), empty: count === 0 });
    }
    // Pad the final partial week so the grid completes cleanly.
    while (allCells.length % 7 !== 0) allCells.push(null);

    const weeks = allCells.length / 7;
    const ns = 'http://www.w3.org/2000/svg';
    const cellSize = 13;
    const gap = 3;
    const step = cellSize + gap;
    const left = 28;
    const top = 20;
    const width = left + weeks * step + 4;
    const height = top + 7 * step + 4;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', year + ' 年收藏热力图');
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    const labelColor = 'var(--muted)';
    const weekdays = ['', '一', '', '三', '', '五', ''];
    weekdays.forEach((label, i) => {
      if (!label) return;
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(left - 8));
      text.setAttribute('y', String(top + i * step + 10));
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', labelColor);
      text.textContent = label;
      svg.appendChild(text);
    });

    const colors = heatmapColors();
    for (let i = 0; i < allCells.length; i++) {
      const cd = allCells[i];
      const weekCol = Math.floor(i / 7);
      const row = i % 7;
      const x = left + weekCol * step;
      const y = top + row * step;
      if (!cd) {
        continue;
      } else {
        if (cd.month !== lastMonth) {
          monthCols.push({ month: cd.month, label: monthNames[cd.month], col: weekCol });
          lastMonth = cd.month;
          const text = document.createElementNS(ns, 'text');
          text.setAttribute('x', String(x));
          text.setAttribute('y', '10');
          text.setAttribute('font-size', '10');
          text.setAttribute('fill', labelColor);
          text.textContent = monthNames[cd.month];
          svg.appendChild(text);
        }
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(cellSize));
        rect.setAttribute('height', String(cellSize));
        rect.setAttribute('rx', '2');
        rect.setAttribute('ry', '2');
        if (cd.empty) {
          rect.setAttribute('class', 'heatSvgCell empty l0');
          rect.setAttribute('fill', colors[0]);
          rect.setAttribute('stroke', '#e3e3e3');
          rect.setAttribute('stroke-width', '1');
          const title = document.createElementNS(ns, 'title');
          title.textContent = cd.key + '：无收藏';
          rect.appendChild(title);
        } else {
          const bucket = makeDayBucket(cd.day, cd.count);
          const level = heatLevel(cd.count, max);
          rect.setAttribute('class', 'heatSvgCell clickable l' + level);
          rect.setAttribute('fill', colors[level] || colors[1]);
          rect.style.cursor = 'pointer';
          rect.setAttribute('data-time-bucket', bucketDomKey(bucket));
          const title = document.createElementNS(ns, 'title');
          title.textContent = cd.key + '：' + cd.count + ' 条，点击查看';
          rect.appendChild(title);
          rect.addEventListener('click', () => applyTimeBucketFocus(bucket, 'day'));
          total += cd.count;
          activeDays++;
          if (cd.count > peak.count) peak = { count: cd.count, key: cd.key };
        }
        svg.appendChild(rect);
      }
    }
    grid.appendChild(svg);
    grid.dataset.renderedCells = String(allCells.length);
    grid.dataset.activeDays = String(activeDays);
    return { monthCols, total, activeDays, peak, weeks, inlineSvg: true };
  }

  function renderBucketHeatmap(stats, grid, group) {
    const normalized = buildTrendBuckets(Object.assign({}, stats, { groupBy: group }));
    const buckets = normalized.buckets || [];
    const colors = heatmapColors();
    const max = Math.max(1, ...buckets.map((b) => Number(b.count) || 0));
    const ns = 'http://www.w3.org/2000/svg';
    const itemCount = Math.max(1, buckets.length);
    const cellGap = 8;
    const labelH = 22;
    const maxCols = group === 'year' ? 10 : group === 'half' ? 12 : group === 'month' ? 12 : group === 'biweek' ? 12 : 16;
    const cols = Math.min(maxCols, Math.max(1, itemCount));
    const rows = Math.ceil(itemCount / cols);
    const cellW = group === 'week' ? 46 : group === 'biweek' ? 58 : group === 'month' ? 66 : group === 'half' ? 84 : 86;
    const cellH = group === 'week' ? 34 : 42;
    const left = 12;
    const top = 12;
    const width = left * 2 + cols * cellW + Math.max(0, cols - 1) * cellGap;
    const height = top * 2 + rows * cellH + Math.max(0, rows - 1) * cellGap + labelH;

    grid.innerHTML = '';
    grid.className = 'heatmapGrid heatmap-svg heatmap-bucket';
    grid.style.cssText = [
      'display:block',
      'width:max-content',
      'min-width:' + Math.max(520, width) + 'px',
      'height:' + Math.max(136, height) + 'px',
      'min-height:' + Math.max(136, height) + 'px',
      'padding:0',
      'margin:0',
    ].join(';') + ';';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', heatmapModeLabel(group));
    svg.style.display = 'block';

    let total = 0;
    let activeDays = 0;
    let peak = { count: 0, key: '' };
    if (!buckets.length) {
      const empty = document.createElementNS(ns, 'text');
      empty.setAttribute('x', '16');
      empty.setAttribute('y', '34');
      empty.setAttribute('fill', 'var(--muted)');
      empty.setAttribute('font-size', '12');
      empty.textContent = '当前粒度暂无可统计记录';
      svg.appendChild(empty);
    }

    buckets.forEach((bucket, i) => {
      const count = Number(bucket.count) || 0;
      const level = heatLevel(count, max);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + cellGap);
      const y = top + row * (cellH + cellGap);
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(cellW));
      rect.setAttribute('height', String(cellH));
      rect.setAttribute('rx', '10');
      rect.setAttribute('ry', '10');
      rect.setAttribute('class', 'heatSvgCell bucketCell clickable l' + level);
      rect.setAttribute('fill', colors[level] || colors[0]);
      rect.setAttribute('stroke', level ? 'rgba(164,22,26,0.24)' : '#e3e3e3');
      rect.setAttribute('stroke-width', '1');
      rect.setAttribute('data-time-bucket', bucketDomKey(bucket));
      rect.style.cursor = 'pointer';
      rect.addEventListener('click', () => applyTimeBucketFocus(bucket, group));
      const title = document.createElementNS(ns, 'title');
      title.textContent = (bucket.label || bucket.key) + '：' + count + ' 条，点击查看';
      rect.appendChild(title);
      svg.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(x + cellW / 2));
      label.setAttribute('y', String(y + cellH / 2 - 2));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', group === 'week' ? '9' : '10');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', level >= 3 ? '#fff' : 'var(--fg)');
      label.textContent = trendAxisLabel(bucket, group);
      svg.appendChild(label);

      const value = document.createElementNS(ns, 'text');
      value.setAttribute('x', String(x + cellW / 2));
      value.setAttribute('y', String(y + cellH / 2 + 12));
      value.setAttribute('text-anchor', 'middle');
      value.setAttribute('font-size', '9');
      value.setAttribute('fill', level >= 3 ? 'rgba(255,255,255,0.88)' : 'var(--muted)');
      value.textContent = count + ' 条';
      svg.appendChild(value);

      total += count;
      if (count > 0) activeDays++;
      if (count > peak.count) peak = { count, key: bucket.label || bucket.key };
    });

    const caption = document.createElementNS(ns, 'text');
    caption.setAttribute('x', String(left));
    caption.setAttribute('y', String(height - 6));
    caption.setAttribute('fill', 'var(--muted)');
    caption.setAttribute('font-size', '11');
    caption.textContent = heatmapModeLabel(group) + ' · 与右侧趋势图使用同一组时间段数据';
    svg.appendChild(caption);

    grid.appendChild(svg);
    grid.dataset.renderedCells = String(buckets.length);
    grid.dataset.activeDays = String(activeDays);
    return { monthCols: [], total, activeDays, peak, weeks: cols, inlineSvg: true, bucketMode: true };
  }

function renderHeatmapMonths(monthCols, totalWeeks) {
    const host = $('heatmapMonths');
    if (!host) return;
    host.innerHTML = '';
    if (!monthCols || !monthCols.length) return;
    // 0.5.2: cell=14px + column-gap=3px = 17px per week column
    const colWidth = 17;
    for (let i = 0; i < monthCols.length; i++) {
      const m = monthCols[i];
      const next = monthCols[i + 1];
      const weekSpan = next ? (next.col - m.col) : Math.max(1, (totalWeeks || m.col + 1) - m.col);
      const lbl = document.createElement('i');
      lbl.textContent = m.label;
      lbl.style.marginLeft = (i === 0 ? m.col * colWidth : 0) + 'px';
      lbl.style.width = (weekSpan * colWidth) + 'px';
      lbl.style.minWidth = '14px';
      lbl.style.display = 'inline-block';
      host.appendChild(lbl);
    }
  }

 function renderHeatmapWeekdays() {
   const host = $('heatmapWeekdays');
   if (!host) return;
   // 0.5.1: GitHub style - only show Mon/Wed/Fri labels
   const labels = ['', '一', '', '三', '', '五', ''];
   host.innerHTML = '';
   for (let i = 0; i < 7; i++) {
     const lbl = document.createElement('i');
     lbl.textContent = labels[i];
     if (labels[i]) lbl.className = 'show';
     host.appendChild(lbl);
  }
}

  function buildMonthlyBucketsFromDaily(stats, year) {
    const daily = stats.daily || [];
    const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const counts = new Array(12).fill(0);
    const prefix = year + '-';
    for (const d of daily) {
      if (!d.date || !d.date.startsWith(prefix)) continue;
      const m = Number(d.date.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) counts[m] += Number(d.count) || 0;
    }
    const out = [];
    for (let i = 0; i < 12; i++) {
      const from = new Date(year, i, 1).getTime();
      const to = new Date(year, i + 1, 1).getTime();
      out.push({ key: year + '-' + pad2(i + 1), label: monthNames[i], count: counts[i], from, to, groupBy: 'month' });
    }
    return out;
  }

  function buildTrendBuckets(stats) {
    const group = stats.groupBy || getTimeGroupBy() || 'month';
    const buckets = (stats.buckets || [])
      .map((b) => normalizeTimeBucket(b, group))
      .filter(Boolean)
      .sort((a, b) => a.from - b.from);
    if (buckets.length) return { group, buckets };

    const heatYear = Number(stats.heatmapYear) || new Date().getFullYear();
    return {
      group: 'month',
      buckets: buildMonthlyBucketsFromDaily(stats, heatYear)
        .map((b) => normalizeTimeBucket(b, 'month'))
        .filter(Boolean),
    };
  }

  function trendAxisLabel(bucket, group) {
    const key = String(bucket && bucket.key ? bucket.key : '');
    if (group === 'day') return key.slice(5) || key;
    if (group === 'week') return (key.slice(5) || key) + '周';
    if (group === 'month') return key;
    if (group === 'biweek') {
      const m = /^(\d{4})-B(\d{2})$/.exec(key);
      if (!m) return key;
      const halfMonth = Number(m[2]);
      const monthNum = Math.ceil(halfMonth / 2);
      return monthNum + (halfMonth % 2 === 1 ? '月上' : '月下');
    }
    if (group === 'half') return key.replace('-H', ' H');
    return key || String(bucket && bucket.label ? bucket.label : '');
  }

  function shouldShowTrendTick(index, total) {
    if (total <= 12) return true;
    if (index === 0 || index === total - 1) return true;
    return index % Math.ceil(total / 8) === 0;
  }

  // 收藏趋势折线图：跟随当前展示粒度，横坐标显示真实时间桶。
  function renderTrendChart(stats) {
    const svg = $('trendSvg');
    const peakEl = $('trendPeak');
    if (!svg || !peakEl) return;
    svg.innerHTML = '';
    peakEl.innerHTML = '';

    const trend = buildTrendBuckets(stats);
    const buckets = trend.buckets;
    const group = trend.group;
    const hasData = buckets.some((b) => Number(b.count) > 0);
    if ($('trendTitle')) $('trendTitle').textContent = '收藏趋势（按' + timeUnitName(group) + '）';

    const W = 340, H = 150;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    if (!buckets.length || !hasData) {
      peakEl.textContent = '暂无收藏记录';
      const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      baseline.setAttribute('x1', '10');
      baseline.setAttribute('x2', String(W - 10));
      baseline.setAttribute('y1', String(H - 25));
      baseline.setAttribute('y2', String(H - 25));
      baseline.setAttribute('stroke', 'var(--line)');
      baseline.setAttribute('stroke-width', '1');
      svg.appendChild(baseline);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(W / 2));
      t.setAttribute('y', String(H / 2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', 'var(--muted)');
      t.setAttribute('font-size', '11');
      t.textContent = '暂无趋势数据';
      svg.appendChild(t);
      return;
    }

    const maxCount = Math.max(1, ...buckets.map((b) => Number(b.count) || 0));
    const peak = buckets.reduce((a, b) => ((Number(b.count) || 0) > (Number(a.count) || 0) ? b : a), buckets[0]);
    peakEl.innerHTML = '峰值 <b>' + (Number(peak.count) || 0) + '</b> 条 · ' + esc(peak.label || peak.key);

    const padding = { top: 12, right: 14, bottom: 32, left: 34 };
    const graphWidth = W - padding.left - padding.right;
    const graphHeight = H - padding.top - padding.bottom;

    // 渐变定义（红色系）
    const ns = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(ns, 'defs');
    const grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', 'trendGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const stop1 = document.createElementNS(ns, 'stop');
    stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#e63946'); stop1.setAttribute('stop-opacity', '0.28');
    const stop2 = document.createElementNS(ns, 'stop');
    stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#e63946'); stop2.setAttribute('stop-opacity', '0.0');
    grad.appendChild(stop1); grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // 水平网格线 + Y 轴刻度
    const gridCount = 3;
    for (let i = 0; i <= gridCount; i++) {
      const yVal = padding.top + (graphHeight * i) / gridCount;
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', String(padding.left));
      ln.setAttribute('x2', String(W - padding.right));
      ln.setAttribute('y1', String(yVal));
      ln.setAttribute('y2', String(yVal));
      ln.setAttribute('stroke', 'var(--line)');
      ln.setAttribute('stroke-width', '0.5');
      if (i < gridCount) ln.setAttribute('stroke-dasharray', '2,3');
      svg.appendChild(ln);
      const val = Math.round(maxCount - (maxCount * i) / gridCount);
      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', String(padding.left - 4));
      txt.setAttribute('y', String(yVal + 3));
      txt.setAttribute('text-anchor', 'end');
      txt.setAttribute('fill', 'var(--muted)');
      txt.setAttribute('font-size', '8');
      txt.textContent = String(val);
      svg.appendChild(txt);
    }

    // 数据点位置
    const stepX = buckets.length > 1 ? graphWidth / (buckets.length - 1) : graphWidth;
    const points = buckets.map((b, i) => {
      const x = padding.left + (buckets.length > 1 ? i * stepX : graphWidth / 2);
      const y = padding.top + graphHeight - ((Number(b.count) || 0) / maxCount) * graphHeight;
      return { x, y, bucket: b };
    });

    const axis = document.createElementNS(ns, 'line');
    axis.setAttribute('x1', String(padding.left));
    axis.setAttribute('x2', String(W - padding.right));
    axis.setAttribute('y1', String(padding.top + graphHeight));
    axis.setAttribute('y2', String(padding.top + graphHeight));
    axis.setAttribute('stroke', 'var(--muted)');
    axis.setAttribute('stroke-width', '0.6');
    axis.setAttribute('opacity', '0.55');
    svg.appendChild(axis);

    // 填充面积
    const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    const fillPath = linePath + ' L' + points[points.length - 1].x.toFixed(1) + ',' + (padding.top + graphHeight) + ' L' + points[0].x.toFixed(1) + ',' + (padding.top + graphHeight) + ' Z';
    const fp = document.createElementNS(ns, 'path');
    fp.setAttribute('d', fillPath);
    fp.setAttribute('fill', 'url(#trendGrad)');
    svg.appendChild(fp);

    // 折线
    const sp = document.createElementNS(ns, 'path');
    sp.setAttribute('d', linePath);
    sp.setAttribute('fill', 'none');
    sp.setAttribute('stroke', '#e63946');
    sp.setAttribute('stroke-width', '1.8');
    sp.setAttribute('stroke-linejoin', 'round');
    sp.setAttribute('stroke-linecap', 'round');
    svg.appendChild(sp);

    // 峰值高亮竖虚线
    const peakPoint = points[buckets.indexOf(peak)];
    if (peakPoint) {
      const pl = document.createElementNS(ns, 'line');
      pl.setAttribute('x1', peakPoint.x.toFixed(1));
      pl.setAttribute('x2', peakPoint.x.toFixed(1));
      pl.setAttribute('y1', peakPoint.y.toFixed(1));
      pl.setAttribute('y2', String(padding.top + graphHeight));
      pl.setAttribute('stroke', '#e63946');
      pl.setAttribute('stroke-width', '1');
      pl.setAttribute('stroke-dasharray', '3,2');
      pl.setAttribute('opacity', '0.4');
      svg.appendChild(pl);
    }

    // 交互圆点；点太多时只保留峰值和刻度点，避免 SVG 节点过多。
    points.forEach((p, i) => {
      const isPeak = p.bucket === peak;
      const isTick = shouldShowTrendTick(i, points.length);
      if (points.length > 120 && !isPeak && !isTick) return;
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', isPeak ? '3.5' : '2.5');
      c.setAttribute('fill', isPeak ? '#e63946' : 'var(--bg)');
      c.setAttribute('stroke', '#e63946');
      c.setAttribute('stroke-width', '1.5');
      c.setAttribute('class', 'trend-dot');
      c.style.cursor = 'pointer';
      c.style.transition = 'all 0.15s ease';
      c.addEventListener('mouseenter', (e) => {
        c.setAttribute('r', '5');
        let tooltip = document.querySelector('.trend-tooltip');
        if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'trend-tooltip'; document.body.appendChild(tooltip); }
        tooltip.innerHTML = '<strong>' + esc(p.bucket.label || p.bucket.key) + '</strong><br/>新增: <strong>' + (p.bucket.count || 0) + '</strong> 条';
        tooltip.style.display = 'block';
        const rect = e.target.getBoundingClientRect();
        tooltip.style.left = (window.scrollX + rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
        tooltip.style.top = (window.scrollY + rect.top - tooltip.offsetHeight - 8) + 'px';
      });
      c.addEventListener('mouseleave', () => {
        c.setAttribute('r', isPeak ? '3.5' : '2.5');
        const tooltip = document.querySelector('.trend-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      });
      c.addEventListener('click', () => { applyTimeBucketFocus(p.bucket, group); });
      svg.appendChild(c);
    });

    // X 轴：按当前粒度显示真实时间横坐标。
    points.forEach((p, i) => {
      if (!shouldShowTrendTick(i, points.length)) return;
      const b = buckets[i];
      const tick = document.createElementNS(ns, 'line');
      tick.setAttribute('x1', p.x.toFixed(1));
      tick.setAttribute('x2', p.x.toFixed(1));
      tick.setAttribute('y1', String(padding.top + graphHeight));
      tick.setAttribute('y2', String(padding.top + graphHeight + 4));
      tick.setAttribute('stroke', 'var(--muted)');
      tick.setAttribute('stroke-width', '0.6');
      tick.setAttribute('opacity', '0.55');
      svg.appendChild(tick);
      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', p.x.toFixed(1));
      txt.setAttribute('y', String(H - 8));
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('fill', 'var(--muted)');
      txt.setAttribute('font-size', '8.5');
      txt.textContent = trendAxisLabel(b, group);
      svg.appendChild(txt);
    });
  }
  function bindTrendRange() {}
  function renderHeatmapStats(info, sourceLabel) {
    const host = $('heatmapStats');
    if (!host) return;
    host.innerHTML = '';
    const total = (info && info.total) || 0;
    const peak = (info && info.peak) || { count: 0, key: '' };
    const active = (info && info.activeDays) || 0;
    const items = [
      { v: String(total), l: '累计收藏', sub: sourceLabel || '' },
      { v: String(peak.count || 0), l: '单日峰值', sub: peak.key || '—' },
      { v: String(active), l: '活跃天数', sub: '年内' },
    ];
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'heatmapStat';
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = it.v;
      const l = document.createElement('div');
      l.className = 'l';
      l.textContent = it.l;
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = it.sub;
      card.appendChild(v);
      card.appendChild(l);
      card.appendChild(s);
      host.appendChild(card);
    }
  }

  // 0.4.27: 热力图始终用 GitHub 风格的日网格，数据来自 stats.daily，
  // 不受 groupBy（按年/月/周/半年）影响。groupBy 只影响下方的 timeBuckets 条形列表。
  function renderHeatmap(stats) {
    const grid = $('heatmapGrid');
    if (!grid) return;
    try {
    const group = stats.groupBy || getTimeGroupBy() || 'day';
    grid.className = 'heatmapGrid';
    grid.innerHTML = '';
    const info = group === 'day' ? (renderDayHeatmap(stats, grid) || {}) : (renderBucketHeatmap(stats, grid, group) || {});
    if (info.inlineSvg) {
      if ($('heatmapMonths')) $('heatmapMonths').innerHTML = '';
      if ($('heatmapWeekdays')) $('heatmapWeekdays').innerHTML = '';
    } else {
      renderHeatmapMonths(info.monthCols || [], info.weeks || 0);
      renderHeatmapWeekdays();
    }
    const source = normalizeTimeSource(stats.timeSource || state.timeSource);
    renderHeatmapStats(info, timeSourceLabel(source));
    updateHeatYearLabel();
    } catch (e) {
      grid.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px;">热力图渲染异常：' + (e && e.message ? e.message : String(e)) + '</div>';
    }
  }

  function renderTimeBuckets(stats) {
    const host = $('timeBuckets');
    host.innerHTML = '';
    const group = stats.groupBy || 'year';
    const buckets = (stats.buckets || []).map((b) => normalizeTimeBucket(b, group)).filter(Boolean);
    const titles = { year: '按年统计', half: '按半年统计', month: '按月统计', week: '按周统计', day: '按日统计' };
    $('timeBucketTitle').textContent = (titles[group] || '分类统计') + ' · 点击某一行查看该时间段';
    if (!buckets.length) {
      const empty = document.createElement('div');
      empty.className = 'muted small';
      empty.textContent = '暂无可统计的收藏记录';
      host.appendChild(empty);
      return;
    }
    const max = Math.max(1, ...buckets.map((b) => b.count || 0));
    for (const b of buckets) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bucketRow clickable';
      row.dataset.timeBucket = bucketDomKey(b);
      row.title = '查看 ' + b.label + ' 的书签';

      const label = document.createElement('div');
      label.className = 'bucketLabel';
      label.textContent = b.label || b.key;

      const track = document.createElement('div');
      track.className = 'bucketTrack';
      const fill = document.createElement('div');
      fill.className = 'bucketFill';
      fill.style.width = Math.max(4, Math.round((b.count || 0) / max * 100)) + '%';
      track.appendChild(fill);

      const count = document.createElement('div');
      count.className = 'bucketCount';
      count.textContent = String(b.count || 0);

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(count);
      row.addEventListener('click', () => applyTimeBucketFocus(b, group));
      host.appendChild(row);
    }
  }

  function bindTimeControls() {
    if (!$('timeMode')) return;
    syncTimeInputs();
    $('timeMode').addEventListener('change', () => {
      clearTimeFocus();
      readTimeInputs();
      ensureTimeDefaults();
      syncTimeInputs();
      refreshList();
    });
    if ($('timeSource')) {
      $('timeSource').addEventListener('change', () => {
        clearTimeFocus();
        readTimeInputs();
        syncTimeInputs();
        refreshList();
      });
    }
    if ($('timeGroup')) {
      $('timeGroup').addEventListener('change', () => {
        clearTimeFocus();
        readTimeInputs();
        refreshList();
      });
    }
    if ($('timeVizToggle')) {
      $('timeVizToggle').addEventListener('click', () => {
        state.timeVizCollapsed = !state.timeVizCollapsed;
        syncTimeVizCompact();
      });
    }

    // 0.4.28: 热力图年份导航（« 2026 »），可直接切换年份而不需走时间筛选
    if ($('heatYearPrev')) {
      $('heatYearPrev').addEventListener('click', () => {
        const stats = state._lastTimeStats;
        const cur = stats && stats.heatmapYear ? stats.heatmapYear : new Date().getFullYear();
        setHeatmapYearOverride(cur - 1);
      });
    }
    if ($('heatYearNext')) {
      $('heatYearNext').addEventListener('click', () => {
        const stats = state._lastTimeStats;
        const cur = stats && stats.heatmapYear ? stats.heatmapYear : new Date().getFullYear();
        setHeatmapYearOverride(cur + 1);
      });
    }
    ['timeYear', 'timeHalfYear', 'timeHalfPart', 'timeMonth', 'timeDay', 'timeFrom', 'timeTo'].forEach((id) => {
      if (!$(id)) return;
      $(id).addEventListener('change', () => {
        clearTimeFocus();
        readTimeInputs();
        refreshList();
      });
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeFocus();
          readTimeInputs();
          refreshList();
        }
      });
    });
    $('timeClear').addEventListener('click', () => {
      state.timeFilter = { mode: 'all', year: '', halfYear: '', halfPart: '1', month: '', day: '', from: '', to: '' };
      clearTimeFocus();
      syncTimeInputs();
      refreshList();
    });
  }
  async function loadAll() {
    const [stats, cats] = await Promise.all([
      send('xb/stats'),
      send('xb/categories/list'),
    ]);
    if (stats.ok) renderStats(stats.data);
    if (cats.ok) { state.categories = cats.data; renderCatNav(); }
    refreshDashAuthors();
    await refreshFullSyncStatus();
  }
  async function refreshDashAuthors() {
    dashAuthorsToken++;
    const token = dashAuthorsToken;
    const r = await send('xb/authors/stats', { query: {} });
    if (token !== dashAuthorsToken) return;
    const host = $('dashAuthorList');
    if (!host) return;
    if (!r.ok) {
      host.innerHTML = '<div class="dashAuthorsEmpty">加载博主失败：' + esc(r.error || '未知错误') + '</div>';
      syncDashboardTopHeight();
      return;
    }
    const data = r.data || {};
    const authors = data.authors || [];
    dashAuthorsCache = authors;
    const countEl = $('dashAuthorCount');
    if (countEl) countEl.textContent = (data.authorCount || 0) + ' 位 · ' + (data.total || 0) + ' 条';
    host.innerHTML = '';
    if (!authors.length) {
      host.innerHTML = '<div class="dashAuthorsEmpty">同步书签后会按收藏过的博主自动整理</div>';
      syncDashboardTopHeight();
      return;
    }
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'dashAllAuthors' + (!state.activeAuthorId ? ' active' : '');
    allBtn.textContent = '全部博主 · ' + (data.total || 0) + ' 条';
    allBtn.addEventListener('click', () => clearAuthorFilter());
    host.appendChild(allBtn);
    const max = Math.max(1, ...authors.map((a) => a.count || 0));
    for (const a of authors) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dashAuthor' + (state.activeAuthorId && a.handle && a.handle.toLowerCase() === String(state.activeAuthorId).toLowerCase() ? ' active' : '');
      row.title = '查看 @' + (a.handle || '') + ' 的全部收藏';
      const av = document.createElement('div');
      av.className = 'dAvatar';
      const avUrl = String(a.avatar || '');
      if (avUrl) {
        const img = document.createElement('img');
        img.src = avUrl.replace(/_normal\.(png|jpg|jpeg|webp)/i, '_bigger.$1');
        img.alt = a.name || a.handle || '';
        img.loading = 'lazy';
        img.onerror = () => { img.remove(); av.textContent = ((a.name || a.handle || '?').trim().charAt(0) || '?').toUpperCase(); };
        av.appendChild(img);
      } else {
        av.textContent = ((a.name || a.handle || '?').trim().charAt(0) || '?').toUpperCase();
      }
      const body = document.createElement('div');
      body.className = 'dBody';
      const name = document.createElement('div');
      name.className = 'dName';
      name.textContent = a.name || '(无名)';
      const handle = document.createElement('div');
      handle.className = 'dHandle';
      handle.textContent = a.handle ? ('@' + a.handle) : '';
      const stats = document.createElement('div');
      stats.className = 'dCount';
      const statParts = [];
      if (a.followers) statParts.push('<b>' + formatCount(a.followers) + '</b>粉丝');
      if (a.statuses) statParts.push('<b>' + formatCount(a.statuses) + '</b>推文');
      statParts.push('<b>' + (a.count || 0) + '</b>收藏');
      stats.innerHTML = statParts.join(' · ');
      body.appendChild(name);
      body.appendChild(handle);
      body.appendChild(stats);
      row.appendChild(av);
      row.appendChild(body);
      row.addEventListener('click', () => openAuthor(a.handle));
      host.appendChild(row);
    }
    const hasProfileStats = authors.some((a) => a.followers || a.statuses);
    if (!hasProfileStats) {
      const hint = document.createElement('div');
      hint.className = 'dashAuthorHint';
      hint.textContent = '粉丝/推文数需「完整同步全部书签」后补全。';
      host.appendChild(hint);
    }
    syncDashboardTopHeight();
  }
  function clearAuthorFilter() {
    state.activeAuthorId = null;
    if (state.view === 'author') state.view = 'all';
    qsa('.navItem').forEach((el) => el.classList.remove('active'));
    const active = qsa('.navItem').find((el) => el.dataset.view === 'all');
    if (active) active.classList.add('active');
    refreshDashAuthors();
    refreshList();
  }
  function isDashboardView() {
    return ['all', 'uncategorized', 'removed', 'cat', 'author'].includes(state.view);
  }
  function syncDashboardTopHeight() {
    const wrap = $('dashWrap');
    const side = $('dashSide');
    const panel = $('timePanel');
    if (!wrap || !side || !panel) return;
    const shouldSync = !wrap.classList.contains('singleCol') && !wrap.classList.contains('collapsed') && !side.classList.contains('hidden') && !panel.classList.contains('hidden');
    if (!shouldSync) {
      side.style.height = '';
      return;
    }
    requestAnimationFrame(() => {
      if (!panel || panel.classList.contains('hidden')) return;
      const h = Math.ceil(panel.getBoundingClientRect().height);
      side.style.height = h > 0 ? (h + 'px') : '';
    });
  }
  function setDashboardVisible(show) {
    // 0.4.21: #list / #empty live inside dashWrap > dashMain. Several
    // non-dashboard views (ai-settings / ai-pending / history / authors)
    // render their content into #list, so hiding the entire wrap would
    // blank out the settings UI as well. Instead we only toggle the
    // dashboard-only sidebar (left author column) and let the grid
    // collapse to a single column via the .singleCol class.
    const wrap = $('dashWrap');
    if (wrap) {
      wrap.classList.toggle('hidden', false);
      wrap.classList.toggle('singleCol', !show);
    }
    const side = $('dashSide');
    if (side) side.classList.toggle('hidden', !show);
    syncDashboardTopHeight();
  }

  function renderStats(s) {
    $('ctAll').textContent = s.total;
    $('ctUncat').textContent = s.uncategorizedCount;
    $('ctRem').textContent = s.removed;
    $('ctPending').textContent = s.pendingAi;
    if ($('ctHistory')) $('ctHistory').textContent = s.historyTotal || 0;
    if ($('ctAuthors')) $('ctAuthors').textContent = s.authorCount || 0;
    $('syncAt').textContent = s.lastSyncAt ? ('已同步 · ' + fmtRel(s.lastSyncAt)) : '未同步';
  }

  function renderFullSyncStatus(s) {
    const active = ['starting', 'running', 'stopping'].includes(s.state);
    $('fullSync').disabled = active;
    $('stopSync').classList.toggle('hidden', !active);
    if (s.state === 'starting') $('syncAt').textContent = '正在连接 X…';
    else if (s.state === 'running') $('syncAt').textContent = '同步中 · ' + s.pages + ' 页 / ' + s.fetched + ' 条';
    else if (s.state === 'stopping') $('syncAt').textContent = '正在停止…';
    else if (s.state === 'completed') $('syncAt').textContent = (s.warning ? '同步完成但受限 · ' : '全量同步完成 · ') + s.fetched + ' 条' + (s.warning ? ' · ' + s.warning : '');
    else if (s.state === 'stopped') $('syncAt').textContent = '同步已停止 · ' + s.fetched + ' 条' + (s.warning ? ' · ' + s.warning : '');
    else if (s.state === 'error') $('syncAt').textContent = '同步失败 · ' + (s.error || '未知错误');

    if (lastFullSyncState && lastFullSyncState !== s.state && ['completed', 'stopped'].includes(s.state)) {
      Promise.all([loadAll(), refreshList()]);
    }
    lastFullSyncState = s.state;
  }

  async function refreshFullSyncStatus() {
    const r = await send('xb/sync/status');
    if (r.ok) renderFullSyncStatus(r.data);
  }

  function renderCatNav() {
    const host = $('catNav');
    host.innerHTML = '';
    if (state.categories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted small';
      empty.style.padding = '4px 8px';
      empty.textContent = '点右上 ＋ 建分类';
      host.appendChild(empty);
      return;
    }
    for (const c of state.categories) {
      const a = document.createElement('a');
      a.className = 'navItem' + (state.view === 'cat' && state.activeCatId === c.id ? ' active' : '');
      a.href = '#';
      a.innerHTML =
        '<span class="dot" style="background:' + c.color + '"></span>' +
        '<span class="lbl"></span>' +
        '<span class="ct"></span>';
      a.querySelector('.lbl').textContent = c.name;
      a.querySelector('.ct').textContent = '·';
      a.addEventListener('click', (e) => { e.preventDefault(); setView('cat', c.id); });
      a.addEventListener('dblclick', () => editCategory(c));
      host.appendChild(a);
    }
  }

  function setView(view, catId) {
    if (view !== state.view || (view === 'all' && state.timeFocus)) {
      clearTimeFocus();
    }
    state.view = view;
    state.activeCatId = catId || null;
    state.selected.clear();
    qsa('.navItem').forEach((el) => el.classList.remove('active'));
    const active = qsa('.navItem').find((el) => el.dataset.view === view);
    if (active) active.classList.add('active');
    refreshList();
    if (view === 'ai-pending') openAiPending();
    if (view === 'ai-settings') openAiSettings();
  }

  function viewTitle() {
    if (state.view === 'all') return '全部';
    if (state.view === 'uncategorized') return '未分类';
    if (state.view === 'removed') return '已忽略';
    if (state.view === 'history') return '浏览记录';
    if (state.view === 'authors') return '关注博主';
    if (state.view === 'author') return '博主书签';
    if (state.view === 'cat') {
      const c = state.categories.find((x) => x.id === state.activeCatId);
      return c ? c.name : '分类';
    }
    return '';
  }

 async function refreshList() {
   if (state.view === 'ai-pending' || state.view === 'ai-settings') {
     listRenderToken++;
     setDashboardVisible(false);
     listPageState = null;
     clearTimeFocus();
     timeStatsToken++;
     setTimePanelVisible(false);
     stopListObserver();
     $('list').innerHTML = '';
     $('empty').classList.add('hidden');
     $('batchBar').classList.add('hidden');
     $('viewTitle').textContent = state.view === 'ai-pending' ? 'AI 提议' : 'AI 设置';
     $('viewCount').textContent = '';
     return;
   }
   if (state.view === 'history') {
     setDashboardVisible(false);
     listRenderToken++;
     listPageState = null;
     clearTimeFocus();
     timeStatsToken++;
     setTimePanelVisible(false);
     stopListObserver();
     $('batchBar').classList.add('hidden');
     $('viewTitle').textContent = '浏览记录';
     $('viewCount').textContent = '';
     await refreshHistory();
     return;
   }
   if (state.view === 'authors') {
      setDashboardVisible(false);
      listRenderToken++;
      listPageState = null;
      clearTimeFocus();
      timeStatsToken++;
      setTimePanelVisible(false);
      stopListObserver();
      $('batchBar').classList.add('hidden');
      $('viewTitle').textContent = '关注博主';
      $('viewCount').textContent = '';
      await refreshAuthors();
      return;
    }
    setDashboardVisible(true);
    if (state.view === 'author') {
      setTimePanelVisible(true);
      syncTimeInputs();
      refreshDashAuthors();
      const baseQuery = getBaseBookmarkQuery();
      baseQuery.authorId = state.activeAuthorId;
      refreshTimeStats(baseQuery);
      if (state.timeFocus && Number(state.timeFocus.from) && Number(state.timeFocus.to)) {
        startPagedList(queryWithTimeBucket(Object.assign({}, baseQuery), state.timeFocus), state.timeFocus.label);
      } else {
        startPagedList(baseQuery, '博主书签');
      }
      return;
    }
    setTimePanelVisible(true);
    syncTimeInputs();
    refreshDashAuthors();

    const baseQuery = getBaseBookmarkQuery();
    refreshTimeStats(baseQuery);

    if (state.timeFocus && Number(state.timeFocus.from) && Number(state.timeFocus.to)) {
      startPagedList(queryWithTimeBucket(baseQuery, state.timeFocus), state.timeFocus.label);
   } else {
     startPagedList(baseQuery, shouldAutoOpenList() ? (state.timeFilter.mode === 'day' ? '选中日期' : '当前范围') : '');
   }
 }

  function stopListObserver() {
    if (listObserver) {
      listObserver.disconnect();
      listObserver = null;
    }
  }

  function updateListCount(rendered, total) {
    $('viewCount').textContent = total
      ? ('· ' + total + ' 条' + (rendered < total ? ' · 已显示 ' + rendered : ''))
      : '';
  }

  function startPagedList(query, titleSuffix) {
    listRenderToken++;
    stopListObserver();
    state.bookmarks = [];
    listPageState = {
      query: Object.assign({}, query),
      nextOffset: 0,
      total: 0,
      loading: false,
      done: false,
    };

    $('viewTitle').textContent = titleSuffix ? viewTitle() + ' · ' + titleSuffix : viewTitle();
    updateListCount(0, 0);
    $('list').innerHTML = '';
    $('empty').classList.add('hidden');
    $('batchBar').classList.add('hidden');
    loadNextListPage(listRenderToken);
  }

  async function loadNextListPage(token) {
    if (!listPageState || token !== listRenderToken || listPageState.loading || listPageState.done) return;
    stopListObserver();
    listPageState.loading = true;
    const list = $('list');
    const oldMore = list.querySelector('[data-role="loadMore"]');
    if (oldMore) oldMore.remove();

    if (listPageState.nextOffset === 0) {
      const loading = document.createElement('div');
      loading.className = 'loadMore';
      loading.dataset.role = 'loadMore';
      loading.textContent = '加载中...';
      list.appendChild(loading);
    }

    const r = await send('xb/bookmarks/list', {
      query: Object.assign({}, listPageState.query, {
        page: true,
        limit: LIST_BATCH_SIZE,
        offset: listPageState.nextOffset,
      }),
    });

    if (!listPageState || token !== listRenderToken) return;
    listPageState.loading = false;
    const loading = list.querySelector('[data-role="loadMore"]');
    if (loading) loading.remove();

    if (!r.ok) {
      $('empty').classList.remove('hidden');
      $('emptyTitle').textContent = '加载失败';
      $('emptyTip').textContent = r.error || '读取书签时出错';
      $('batchBar').classList.add('hidden');
      return;
    }

    const data = r.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total) || 0;
    listPageState.total = total;
    listPageState.nextOffset += items.length;
    listPageState.done = listPageState.nextOffset >= total || items.length === 0;

    appendListItems(items, total, token);

    if (state.bookmarks.length === 0) {
      $('empty').classList.remove('hidden');
      $('emptyTitle').textContent = '这里还空着';
      $('emptyTip').textContent = state.view === 'uncategorized'
        ? '没有未分类的书签，要么是都分完了，要么先点右上「抓当前页」抓一批进来。'
        : '试试换个分类，或先抓取书签页。';
      $('batchBar').classList.add('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    updateBatchBar();
    if (!listPageState.done) appendLoadMore(token);
  }

  function appendListItems(items, total, token) {
    if (token !== listRenderToken) return;
    const list = $('list');
    const frag = document.createDocumentFragment();
    for (const item of items) {
      try {
        state.bookmarks.push(item);
        frag.appendChild(renderRow(item));
      } catch (e) {
        console.warn('跳过无法渲染的书签', item, e);
      }
    }
    list.appendChild(frag);
    updateListCount(state.bookmarks.length, total);
  }

  function appendLoadMore(token) {
    const list = $('list');
    const more = document.createElement('div');
    more.className = 'loadMore';
    more.dataset.role = 'loadMore';
    const total = listPageState ? listPageState.total : 0;
    const loaded = state.bookmarks.length;
    const remaining = Math.max(0, total - loaded);
    const nextCount = Math.min(LIST_BATCH_SIZE, remaining);
    more.innerHTML =
      '<button type="button">继续显示 ' + nextCount + ' 条</button>' +
      '<span class="muted small">已显示 ' + loaded + ' / ' + total + '。为避免卡顿，后续内容只在点击后加载。</span>';
    more.querySelector('button').addEventListener('click', () => loadNextListPage(token));
    list.appendChild(more);
  }

  function historyKindName(kind) {
    const map = {
      tweet: '推文',
      profile: '用户主页',
      search: '搜索',
      bookmarks: '书签页',
      home: '首页',
      notifications: '通知',
      messages: '私信',
      explore: '探索',
      page: '页面',
    };
    return map[kind] || '页面';
  }

  function formatCount(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 >= 1e8 ? 1 : 0).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 >= 1e5 ? 1 : 0).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 >= 1e2 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return String(n);
  }

    async function refreshAuthors() {
    const r = await send('xb/authors/stats', { query: {} });
    const list = $('list');
    list.innerHTML = '';
    $('empty').classList.add('hidden');
    if (!r.ok) {
      const err = document.createElement('div');
      err.className = 'muted';
      err.textContent = '加载博主失败：' + (r.error || '未知错误');
      list.appendChild(err);
      return;
    }
    const data = r.data || {};
    const authors = data.authors || [];
    $('viewCount').textContent = '共 ' + (data.authorCount || 0) + ' 位博主 · ' + (data.total || 0) + ' 条书签';
    const hasProfileStats = authors.some((a) => a.followers || a.statuses);
    if (!hasProfileStats) {
      const note = document.createElement('div');
      note.className = 'timePrompt';
      note.style.marginBottom = '12px';
      const h = document.createElement('h3'); h.textContent = '粉丝/推文数需要重新同步';
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = '这些博主卡片目前只显示昵称和收藏数。粉丝数、推文数等资料是在同步书签时从 X 抓取的；现有书签较早同步、缺少这些字段，重新「完整同步全部书签」一次即可补全。';
      note.appendChild(h); note.appendChild(p);
      list.appendChild(note);
    }
    if (!authors.length) {
      $('empty').classList.remove('hidden');
      $('emptyTitle').textContent = '还没有博主数据';
      $('emptyTip').textContent = '同步书签后，这里会按你收藏过的博主统计；点某位博主可看 ta 的全部收藏。';
      return;
    }
    const max = Math.max(1, ...authors.map((a) => a.count || 0));
    const grid = document.createElement('div');
    grid.className = 'authorGrid';
    for (const a of authors) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'authorCard';
      card.title = '查看 @' + (a.handle || '') + ' 的全部收藏';
      const head = document.createElement('div');
      head.className = 'aAvatar';
      const av = String(a.avatar || '');
      if (av) {
        const img = document.createElement('img');
        img.src = av.replace(/_normal\.(png|jpg|jpeg|webp)/i, '_bigger.$1');
        img.alt = a.name || a.handle || '';
        img.loading = 'lazy';
        img.onerror = () => { img.remove(); head.textContent = ((a.name || a.handle || '?').trim().charAt(0) || '?').toUpperCase(); };
        head.appendChild(img);
      } else {
        head.textContent = ((a.name || a.handle || '?').trim().charAt(0) || '?').toUpperCase();
      }
      const body = document.createElement('div');
      body.className = 'aBody';
      const nameRow = document.createElement('div');
      nameRow.className = 'aNameRow';
      const name = document.createElement('span');
      name.className = 'aName';
      name.textContent = a.name || '(无名)';
      nameRow.appendChild(name);
      if (a.verified) {
        const badge = document.createElement('span');
        badge.className = 'aVerified';
        badge.title = '已认证';
        badge.textContent = '✓';
        nameRow.appendChild(badge);
      }
      const handle = document.createElement('div');
      handle.className = 'aHandle';
      handle.textContent = a.handle ? ('@' + a.handle) : '';
      const stats = document.createElement('div');
      stats.className = 'aStats';
      const statItems = [];
      if (a.followers) statItems.push('<b>' + formatCount(a.followers) + '</b> 粉丝');
      if (a.following) statItems.push('<b>' + formatCount(a.following) + '</b> 关注');
      if (a.statuses) statItems.push('<b>' + formatCount(a.statuses) + '</b> 推文');
      stats.innerHTML = statItems.join(' · ');
      const track = document.createElement('div');
      track.className = 'bucketTrack';
      const fill = document.createElement('div');
      fill.className = 'bucketFill';
      fill.style.width = Math.max(4, Math.round((a.count || 0) / max * 100)) + '%';
      track.appendChild(fill);
      const meta = document.createElement('div');
      meta.className = 'aMeta muted small';
      meta.textContent = '收藏 ' + (a.count || 0) + ' 条' + (a.categorized ? ' · 已分 ' + a.categorized : '') + (a.latest ? ' · 最近 ' + fmtRel(a.latest) : '');
      body.appendChild(nameRow);
      body.appendChild(handle);
      if (statItems.length) body.appendChild(stats);
      body.appendChild(track);
      body.appendChild(meta);
      card.appendChild(head);
      card.appendChild(body);
      card.addEventListener('click', () => openAuthor(a.handle));
      grid.appendChild(card);
    }
    list.appendChild(grid);
  }

  function openAuthor(handle) {
    state.view = 'author';
    state.activeAuthorId = handle || null;
    state.selected.clear();
    qsa('.navItem').forEach((el) => el.classList.remove('active'));
    refreshList();
  }

    async function refreshHistory() {
    const [cfg, r] = await Promise.all([
      send('xb/history/config'),
      send('xb/history/list', { query: { search: state.search || '', limit: 500 } }),
    ]);
    state.historyConfig = cfg.ok ? cfg.data : { enabled: true, maxItems: 2000, total: 0 };
    state.history = r.ok ? r.data : [];
    drawHistoryList(state.history, state.historyConfig);
  }

  function drawHistoryList(arr, cfg) {
    const list = $('list');
    list.innerHTML = '';
    $('empty').classList.add('hidden');
    $('viewTitle').textContent = '浏览记录';
    $('viewCount').textContent = (cfg && cfg.total) ? ('· ' + cfg.total + ' 条') : '';

    const panel = document.createElement('div');
    panel.className = 'settings historySettings';
    panel.innerHTML =
      '<h3>本地浏览记录</h3>' +
      '<p class="muted">开启后，插件会在 x.com / twitter.com 页面自动记录访问过的推文、用户主页、搜索页等。数据只保存在 chrome.storage.local。</p>' +
      '<div class="actions">' +
        '<label><input id="historyEnabled" type="checkbox"> 自动记录</label>' +
        '<label>最多保留 <input id="historyMax" type="number" min="100" max="10000" step="100" style="width:100px"> 条</label>' +
        '<button id="historySave" class="primary">保存设置</button>' +
        '<button id="historyClear" class="danger">清空记录</button>' +
      '</div>';
    list.appendChild(panel);
    panel.querySelector('#historyEnabled').checked = !!(cfg && cfg.enabled);
    panel.querySelector('#historyMax').value = (cfg && cfg.maxItems) || 2000;
    panel.querySelector('#historySave').addEventListener('click', async () => {
      const patch = {
        enabled: panel.querySelector('#historyEnabled').checked,
        maxItems: Number(panel.querySelector('#historyMax').value) || 2000,
      };
      const r = await send('xb/history/config', { patch });
      if (r.ok) { toast('浏览记录设置已保存'); await loadAll(); await refreshHistory(); }
      else toast(r.error, true);
    });
    panel.querySelector('#historyClear').addEventListener('click', async () => {
      if (!confirm('确认清空本地浏览记录？这不会影响你的 X 账号和书签。')) return;
      const r = await send('xb/history/clear');
      if (r.ok) { toast('已清空浏览记录'); await loadAll(); await refreshHistory(); }
      else toast(r.error, true);
    });

    if (arr.length === 0) {
      $('empty').classList.remove('hidden');
      $('emptyTitle').textContent = cfg && cfg.enabled ? '还没有浏览记录' : '浏览记录已关闭';
      $('emptyTip').textContent = cfg && cfg.enabled ? '打开或刷新一个 X 页面后，这里会自动出现记录。' : '打开上方“自动记录”后再访问 X 页面即可开始保存。';
      return;
    }

    for (const h of arr) {
      const item = document.createElement('div');
      item.className = 'historyItem';
      const who = h.author && (h.author.name || h.author.handle)
        ? ' · ' + esc((h.author.name || '') + (h.author.handle ? ' @' + h.author.handle : ''))
        : '';
      item.innerHTML =
        '<div class="body">' +
          '<div class="titleLine">' + esc(h.label || h.title || h.url) + '</div>' +
          '<div class="meta">' +
            '<span>' + historyKindName(h.kind) + '</span>' +
            '<span>访问 ' + (h.visitCount || 1) + ' 次</span>' +
            '<span>最近 ' + fmtRel(h.lastSeenAt) + who + '</span>' +
          '</div>' +
          (h.excerpt ? '<div class="excerpt">' + esc(h.excerpt) + '</div>' : '') +
          '<div class="meta"><a target="_blank" rel="noreferrer" href="' + esc(h.url) + '">' + esc(h.url) + '</a></div>' +
        '</div>' +
        '<div class="actions">' +
          '<a class="openLink" target="_blank" rel="noreferrer" href="' + esc(h.url) + '">打开 ↗</a>' +
          '<button data-act="deleteHistory" class="ghost">删除</button>' +
        '</div>';
      item.querySelector('[data-act="deleteHistory"]').addEventListener('click', async () => {
        const r = await send('xb/history/delete', { ids: [h.id] });
        if (r.ok) { toast('已删除记录'); await loadAll(); await refreshHistory(); }
        else toast(r.error, true);
      });
      list.appendChild(item);
    }
  }

  function renderRow(b) {
    const row = document.createElement('div');
    row.className = 'tweetCard' + (state.selected.has(b.id) ? ' selected' : '');
    row.dataset.id = b.id;

    const cat = b.categoryId ? state.categories.find((c) => c.id === b.categoryId) : null;

    const timeMs = decodeTweetTime(b.tweetTime);

    const media = b.media || [];
    const photos = media.filter((m) => m.type === 'photo');
    const videos = media.filter((m) => m.type === 'video' || m.type === 'gif');
    const links = media.filter((m) => m.type === 'link');

    const photoCount = Math.min(photos.length, 4);
    const photoGridClass = photoCount <= 1 ? 'm1' : photoCount === 2 ? 'm2' : 'm3';
    const photoHtml = photoCount
      ? '<div class="mediaGrid ' + photoGridClass + '">' +
        photos.slice(0, 4).map((p) => '<img loading="lazy" src="' + esc(p.url) + '" alt="">').join('') +
        '</div>'
      : '';

    const videoHtml = videos.slice(0, 1).map((m) => {
      const usePoster = /^http/.test(m.url) && /\.(mp4|m3u8|webm)/i.test(m.url) === false && m.poster;
      if (usePoster) {
        return '<div class="mediaGrid m1"><img loading="lazy" src="' + esc(m.poster) + '" alt=""></div>';
      }
      return '<div class="mediaGrid m1"><video controls preload="none" poster="' + esc(m.poster || '') + '" src="' + esc(m.url) + '"></video></div>';
    }).join('');

    const linkHtml = links.slice(0, 1).map((m) => {
      return '<a class="linkCard" target="_blank" rel="noreferrer" href="' + esc(m.url) + '">🔗 ' + esc(m.url) + '</a>';
    }).join('');

    const mediaHtml = photoHtml + videoHtml + linkHtml;

    const tagsHtml = cat
      ? '<span class="tag"><span class="dot" style="background:' + cat.color + '"></span>' +
        '<span>' + esc(cat.name) + '</span>' +
        '<button data-act="clearCat" title="移出">×</button></span>'
      : '<span class="tag"><span class="dot" style="background:#5b7083"></span><span>未分类</span></span>';

    const notesHtml = b.notes
      ? '<div class="muted small" style="margin-top:6px">📝 ' + esc(b.notes) + '</div>'
      : '';

    row.innerHTML =
      '<div class="check"><input type="checkbox" data-act="select"' + (state.selected.has(b.id) ? ' checked' : '') + '></div>' +
      '<div class="body">' +
        '<div class="head">' +
          '<span class="avatar"></span>' +
          '<div class="authorInfo"><div class="authorRow">' +
            '<span class="author"></span>' +
            '<span class="handle"></span>' +
          '</div></div>' +
        '</div>' +
        '<div class="text collapsed"></div>' +
        '<div class="mediaWrap">' + mediaHtml + '</div>' +
        '<div class="tags">' + tagsHtml + notesHtml + '</div>' +
      '</div>' +
      '<div class="actions">' +
        '<a class="openLink" target="_blank" rel="noreferrer" href="' + esc(b.url) + '">打开 ↗</a>' +
        '<button data-act="assign">归类</button>' +
        '<button data-act="note">笔记</button>' +
        (b.manuallyRemoved
          ? '<button data-act="restore">恢复</button>'
          : '<button data-act="ignore">忽略</button>') +
        '<button data-act="delete" class="danger">删除</button>' +
      '</div>';

    row.querySelector('.author').textContent = (b.author && b.author.name) || '';
    row.querySelector('.handle').textContent = (b.author && b.author.handle) ? ('@' + b.author.handle) : '';
    const authorName = (b.author && b.author.name) || ''; const avatarEl = row.querySelector('.avatar'); if (avatarEl) avatarEl.textContent = authorName ? authorName.charAt(0).toUpperCase() : '?'; if (timeMs) { const authorRow = row.querySelector('.authorRow'); if (authorRow) { const span = document.createElement('span'); span.className = 'cardTime'; span.textContent = fmtDate(timeMs); authorRow.appendChild(span); } }
    row.querySelector('.text').textContent = b.text || '';

    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select, textarea, video')) return;
      row.querySelector('.text').classList.toggle('collapsed');
    });
    row.querySelector('[data-act="select"]').addEventListener('change', (e) => {
      if (e.target.checked) state.selected.add(b.id); else state.selected.delete(b.id);
      row.classList.toggle('selected', e.target.checked);
      updateBatchBar();
    });
    row.querySelector('[data-act="assign"]').addEventListener('click', (e) => { e.stopPropagation(); quickAssign(b); });
    row.querySelector('[data-act="note"]').addEventListener('click', (e) => { e.stopPropagation(); editNote(b); });
    const ignoreBtn = row.querySelector('[data-act="ignore"]');
    if (ignoreBtn) ignoreBtn.addEventListener('click', (e) => { e.stopPropagation(); ignore([b.id]); });
    const restoreBtn = row.querySelector('[data-act="restore"]');
    if (restoreBtn) restoreBtn.addEventListener('click', (e) => { e.stopPropagation(); restore([b.id]); });
    row.querySelector('[data-act="delete"]').addEventListener('click', (e) => { e.stopPropagation(); remove([b.id]); });
    const clearBtn = row.querySelector('[data-act="clearCat"]');
    if (clearBtn) clearBtn.addEventListener('click', (e) => { e.stopPropagation(); assignCat([b.id], null); });

    return row;
  }

  function updateBatchBar() {
    const n = state.selected.size;
    $('selCount').textContent = String(n);
    $('batchBar').classList.toggle('hidden', n === 0);
    // 填充分类下拉
    const sel = $('batchCat');
    sel.innerHTML = '<option value="">— 选分类 —</option>' +
      state.categories.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  }

  async function assignCat(ids, categoryId) {
    const r = await send('xb/bookmarks/assign', { tweetIds: ids, categoryId });
    if (r.ok) { toast('已归类 ' + ids.length + ' 条'); await loadAll(); await refreshList(); }
    else toast(r.error, true);
  }

  async function ignore(ids) {
    const r = await send('xb/bookmarks/markRemoved', { tweetIds: ids, removed: true });
    if (r.ok) { toast('已忽略'); await loadAll(); await refreshList(); }
    else toast(r.error, true);
  }
  async function restore(ids) {
    const r = await send('xb/bookmarks/markRemoved', { tweetIds: ids, removed: false });
    if (r.ok) { toast('已恢复'); await loadAll(); await refreshList(); }
    else toast(r.error, true);
  }
  async function remove(ids) {
    if (!confirm('确认从本地删除这 ' + ids.length + ' 条书签？此操作只影响本地数据，不会动你的 X 书签。')) return;
    const r = await send('xb/bookmarks/delete', { tweetIds: ids });
    if (r.ok) { toast('已删除'); ids.forEach((id) => state.selected.delete(id)); await loadAll(); await refreshList(); }
    else toast(r.error, true);
  }

  async function quickAssign(b) {
    if (state.categories.length === 0) {
      editCategory(null, (c) => { if (c) quickAssign(b); });
      return;
    }
    const choice = prompt(
      '把这条书签归到哪个分类？\n（输入序号，或留空=未分类，输入 n=新建）\n\n' +
      state.categories.map((c, i) => (i + 1) + '. ' + c.name).join('\n'),
      ''
    );
    if (choice === null) return;
    if (choice.trim().toLowerCase() === 'n') { editCategory(null, (c) => { if (c) assignCat([b.id], c.id); }); return; }
    if (choice.trim() === '') { assignCat([b.id], null); return; }
    const i = parseInt(choice, 10) - 1;
    if (isNaN(i) || i < 0 || i >= state.categories.length) { toast('序号无效', true); return; }
    assignCat([b.id], state.categories[i].id);
  }

  async function editNote(b) {
    const v = prompt('给这条书签加条笔记（可留空）：', b.notes || '');
    if (v === null) return;
    const r = await send('xb/bookmarks/setNotes', { tweetId: b.id, notes: v });
    if (r.ok) { toast('已保存'); await refreshList(); }
    else toast(r.error, true);
  }

  function editCategory(c, done) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:grid;place-items:center;z-index:20;';
    const dlg = document.createElement('div');
    dlg.style.cssText = 'background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:20px;width:360px;max-width:92vw;';
    dlg.innerHTML =
      '<h3 style="margin:0 0 12px"></h3>' +
      '<div style="margin-bottom:8px"><label class="muted small">名称</label><input id="cName" style="width:100%"></div>' +
      '<div style="margin-bottom:8px"><label class="muted small">描述（可选）</label><input id="cDesc" style="width:100%"></div>' +
      '<div style="margin-bottom:12px"><label class="muted small">颜色</label><input id="cColor" type="color" style="width:60px;height:28px"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"></div>';
    const actions = dlg.querySelector('div:last-child');
    const saveBtn = document.createElement('button'); saveBtn.className = 'primary'; saveBtn.textContent = '保存';
    const cancelBtn = document.createElement('button'); cancelBtn.textContent = '取消';
    const delBtn = document.createElement('button'); delBtn.className = 'danger'; delBtn.textContent = '删除';
    actions.appendChild(cancelBtn); actions.appendChild(delBtn); actions.appendChild(saveBtn);
    dlg.querySelector('h3').textContent = c ? '编辑分类' : '新建分类';
    dlg.querySelector('#cName').value = c ? c.name : '';
    dlg.querySelector('#cDesc').value = c ? (c.description || '') : '';
    dlg.querySelector('#cColor').value = c ? c.color : '#e63946';
    if (!c) delBtn.remove();

    overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    cancelBtn.onclick = () => { close(); if (done) done(null); };
    delBtn.onclick = async () => {
      if (!confirm('删除分类「' + c.name + '」？该分类下的书签会变成未分类，不会删除书签本身。')) return;
      const r = await send('xb/categories/delete', { id: c.id });
      close();
      if (r.ok) { toast('已删除'); await loadAll(); await refreshList(); if (done) done(null); }
      else toast(r.error, true);
    };
    saveBtn.onclick = async () => {
      const payload = {
        name: dlg.querySelector('#cName').value.trim() || '未命名',
        description: dlg.querySelector('#cDesc').value.trim(),
        color: dlg.querySelector('#cColor').value,
      };
      const r = c
        ? await send('xb/categories/update', { id: c.id, patch: payload })
        : await send('xb/categories/create', payload);
      close();
      if (r.ok) { toast('已保存'); await loadAll(); await refreshList(); if (done) done(r.data); }
      else toast(r.error, true);
    };
    dlg.querySelector('#cName').focus();
  }

  // ---------- AI 提议 ----------

  async function openAiPending() {
    const r = await send('xb/ai/pendingList');
    if (!r.ok) { toast(r.error, true); return; }
    state.pendingBatches = r.data;
    if (state.pendingBatches.length === 0) {
      $('list').innerHTML = '';
      $('empty').classList.remove('hidden');
      $('emptyTitle').textContent = '没有待审的 AI 提议';
      $('emptyTip').textContent = '点右上「✨ AI 整理未分类」让 AI 先跑一轮，结果会先到这里等你确认，不会直接改你的分类。';
      return;
    }
    const batch = state.pendingBatches[0];
    openBatch(batch.id);
  }

  let currentBatch = null;
  let batchDecisions = {}; // tweetId -> {action, categoryId?}

  async function openBatch(batchId) {
    const r = await send('xb/ai/pendingGet', { batchId });
    if (!r.ok) { toast(r.error, true); return; }
    currentBatch = r.data;
    batchDecisions = {};
    $('aiDrawer').classList.remove('hidden');
    $('aiBatchMeta').textContent = new Date(currentBatch.createdAt).toLocaleString() + ' · ' + currentBatch.items.length + ' 条';
    renderAiList();
  }

  function renderAiList() {
    const host = $('aiList');
    host.innerHTML = '';
    for (const it of currentBatch.enriched) {
      const b = it.bookmark;
      const decision = batchDecisions[it.tweetId];
      const item = document.createElement('div');
      let cls = 'aiItem';
      if (decision) cls += ' decision-' + decision.action;
      item.className = cls;
      const existed = it.categoryId ? state.categories.find((c) => c.id === it.categoryId) : null;
      const isnew = !it.categoryId && !!it.categoryName;
      const badge = existed
        ? '<span class="badge">→ ' + esc(existed.name) + '</span>'
        : (isnew ? '<span class="badge new">新建：' + esc(it.categoryName) + '</span>' : '<span class="badge" style="background:#5b7083">未分类</span>');
      item.innerHTML =
        '<div class="left">' +
          '<div class="meta"></div>' +
          '<div class="text"></div>' +
          '<div class="suggest"><span class="muted">AI 建议：</span>' + badge +
            ' <span class="muted small">(' + esc(it.reason || '') + ')</span></div>' +
        '</div>' +
        '<div class="choose"></div>';
      item.querySelector('.meta').textContent = b ? (((b.author && b.author.name) || '') + (b.author && b.author.handle ? ' @' + b.author.handle : '')) : '（书签已删除）';
      item.querySelector('.text').textContent = b ? (b.text || '') : '';

      const choose = item.querySelector('.choose');
      const sel = document.createElement('select');
      sel.innerHTML =
        '<option value="accept">接受</option>' +
        '<option value="reject"' + (decision && decision.action === 'reject' ? ' selected' : '') + '>拒绝</option>' +
        '<option value="reassign">改派…</option>';
      if (decision && decision.action === 'accept') sel.value = 'accept';
      if (decision && decision.action === 'reassign') sel.value = 'reassign';
      const catSel = document.createElement('select');
      catSel.style.display = 'none';
      catSel.innerHTML = '<option value="">— 选已有分类 —</option>' +
        state.categories.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
      if (decision && decision.action === 'reassign' && decision.categoryId) catSel.value = decision.categoryId;
      sel.addEventListener('change', () => {
        if (sel.value === 'accept') { batchDecisions[it.tweetId] = { action: 'accept' }; catSel.style.display = 'none'; }
        else if (sel.value === 'reject') { batchDecisions[it.tweetId] = { action: 'reject' }; catSel.style.display = 'none'; }
        else { catSel.style.display = ''; if (!batchDecisions[it.tweetId] || batchDecisions[it.tweetId].action !== 'reassign') batchDecisions[it.tweetId] = { action: 'reassign', categoryId: catSel.value || null }; }
        renderAiList();
      });
      catSel.addEventListener('change', () => {
        batchDecisions[it.tweetId] = { action: 'reassign', categoryId: catSel.value || null };
      });
      choose.appendChild(sel); choose.appendChild(catSel);
      host.appendChild(item);
    }
    updateAiProgress();
  }

  function updateAiProgress() {
    const n = Object.keys(batchDecisions).length;
    const total = currentBatch ? currentBatch.enriched.length : 0;
    $('aiProgress').textContent = '已决策 ' + n + ' / ' + total;
  }

  async function applyAi() {
    if (!currentBatch) return;
    // 没决策的默认当 accept（AI 建议）
    const decisions = currentBatch.enriched.map((it) => {
      const d = batchDecisions[it.tweetId] || { action: 'accept' };
      return { tweetId: it.tweetId, action: d.action, categoryId: d.categoryId || null };
    });
    const r = await send('xb/ai/apply', { batchId: currentBatch.id, decisions });
    $('aiDrawer').classList.add('hidden');
    currentBatch = null; batchDecisions = {};
    if (r.ok) {
      toast('已应用：接受 ' + (r.data.accept || 0) + ' / 改派 ' + (r.data.reassign || 0) + ' / 拒绝 ' + (r.data.reject || 0));
      await loadAll(); await refreshList();
    } else toast(r.error, true);
  }

  // ---------- AI 设置 ----------

  async function openAiSettings() {
    const cfg = await send('xb/ai/config');
    const c = cfg.ok ? cfg.data : { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
    const list = $('list');
    $('empty').classList.add('hidden');
    $('batchBar').classList.add('hidden');
    $('viewTitle').textContent = 'AI 设置';
    $('viewCount').textContent = '';
    list.innerHTML =
      '<div class="settings">' +
        '<h3>接入方式</h3>' +
        '<p class="muted">支持任何兼容 OpenAI Chat Completions 的接口。API Key 只存在你本地的 chrome.storage.local，不会发到任何第三方服务器（除了你填的接口地址本身）。</p>' +
        '<div class="row"><label>API Base URL</label><input id="aiBase" placeholder="https://api.openai.com/v1"></div>' +
        '<div class="row"><label>API Key</label><input id="aiKey" type="password" placeholder="sk-…"></div>' +
        '<div class="row"><label>模型</label><input id="aiModel" placeholder="gpt-4o-mini"></div>' +
        '<h3>分类提示词（可选）</h3>' +
        '<p class="muted">在这里写给 AI 的额外要求，能让分类更精准。例如：「按领域分成技术、财经、生活、娱乐四类」「AI/大模型相关一律归到『人工智能』」「优先复用已有分类，主题相近不要反复新建」。留空则用默认提示词；这段文字只发给你填的接口，随正文一起发送。</p>' +
        '<div class="row"><label>自定义要求</label><textarea id="aiPrompt" rows="4" placeholder="例如：按领域分技术/财经/生活/娱乐；AI 相关一律归到『人工智能』；优先复用已有分类…"></textarea></div>' +
        '<div class="actions">'  +
          '<button id="aiSave" class="primary">保存</button>' +
          '<button id="aiTest">测试连通</button>' +
          '<span class="muted small" id="aiMsg"></span>' +
        '</div>' +
        '<h3>它做什么 / 不做什么</h3>' +
        '<p class="muted">✅ 做：读取未分类书签的作者和正文，输出一份"建议放进哪个分类"的草稿。<br>' +
          '✅ 不做：直接改你的分类。所有 AI 建议都先进「AI 提议待审」，你点接受才生效。<br>' +
          '✅ 不做：上传图片、媒体或你的笔记。只把文本发给你填的接口。<br>' +
          '✅ 本地优先：不配置 API Key 也能用全部手动功能，AI 只是可选的加速器。</p>' +
      '</div>';
    list.querySelector('#aiBase').value = c.baseUrl || 'https://api.openai.com/v1';
    list.querySelector('#aiKey').value = ''; // 出于安全不回显明文
    list.querySelector('#aiKey').placeholder = c.apiKey ? ('已配置 ' + c.apiKey) : 'sk-…';
   list.querySelector('#aiModel').value = c.model || 'gpt-4o-mini';
    list.querySelector('#aiPrompt').value = c.customPrompt || '';
  list.querySelector('#aiSave').onclick = async () => {
    const base = list.querySelector('#aiBase').value.trim() || 'https://api.openai.com/v1';
     const patch = {
       baseUrl: base,
       model: list.querySelector('#aiModel').value.trim() || 'gpt-4o-mini',
        customPrompt: list.querySelector('#aiPrompt').value.trim(),
     };
     const keyVal = list.querySelector('#aiKey').value.trim();
     if (keyVal) patch.apiKey = keyVal; // 留空就保留旧 key
     const r = await send('xb/ai/config', { patch });
     if (!r.ok) { list.querySelector('#aiMsg').textContent = r.error; return; }
     list.querySelector('#aiKey').value = '';
     list.querySelector('#aiKey').placeholder = r.data.apiKey ? ('已配置 ' + r.data.apiKey) : 'sk-…';
     // 保存成功后，为该端点请求跨域宿主权限（必须在用户手势里调）
     const perm = await ensureHostPermission(base);
     if (perm.ok) {
       list.querySelector('#aiMsg').textContent = perm.already ? '已保存（权限已具备）' : '已保存，并已授权访问该端点';
     } else {
       list.querySelector('#aiMsg').textContent = '已保存，但未授权访问端点：' + (perm.error || '已拒绝') + '。AI 调用可能失败，可重新保存再次授权。';
     }
   };
   list.querySelector('#aiTest').onclick = async () => {
     const base = list.querySelector('#aiBase').value.trim() || 'https://api.openai.com/v1';
     list.querySelector('#aiMsg').textContent = '测试中…';
     // 测试前先确保有权限，否则跨域请求会被拦
     const perm = await ensureHostPermission(base);
     if (!perm.ok) { list.querySelector('#aiMsg').textContent = '❌ 需先授权访问该端点：' + (perm.error || '已拒绝'); return; }
     const r = await send('xb/ai/ping');
     list.querySelector('#aiMsg').textContent = r.ok
       ? ('✅ 连通：' + r.data.reply)
       : ('❌ ' + r.error + (/\b(CORS|Failed to fetch|NetworkError|HTTP 0)\b/i.test(r.error || '') ? '（可能是端点地址或权限问题）' : ''));
   };
  }

  // ---------- 导入 / 导出 ----------

  async function exportData() {
    const r = await send('xb/stats');
    const all = await send('xb/bookmarks/list', { query: { includeRemoved: true } });
    const cats = await send('xb/categories/list');
    const cfg = await send('xb/ai/config');
    const history = await send('xb/history/list', { query: { limit: 10000 } });
    const historyCfg = await send('xb/history/config');
    const dump = {
      exportedAt: Date.now(),
      version: 1,
      categories: cats.ok ? cats.data : [],
      bookmarks: all.ok ? all.data : [],
      history: history.ok ? history.data : [],
      historyConfig: historyCfg.ok ? historyCfg.data : {},
      ai: cfg.ok ? cfg.data : {},
      meta: r.ok ? r.data : {},
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'x-bookmarks-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出');
  }

  // ---------- 绑定 ----------

  function bind() {
    bindTimeControls();
    bindTrendRange();
    if ($('dashAuthorToggle')) {
      $('dashAuthorToggle').addEventListener('click', () => {
        const wrap = $('dashWrap');
        if (!wrap) return;
        const collapsed = wrap.classList.toggle('collapsed');
        const btn = $('dashAuthorToggle');
        if (btn) btn.textContent = collapsed ? '展开' : '收起';
        syncDashboardTopHeight();
      });
    }
    qsa('.navItem').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        setView(el.dataset.view, null);
      });
    });
    $('newCat').addEventListener('click', () => editCategory(null));
    $('search').addEventListener('input', window.XBUtil ? XBUtil.debounce((e) => { state.search = e.target.value; refreshList(); }, 250) : (e) => { state.search = e.target.value; refreshList(); });
    $('scanNow').addEventListener('click', async () => {
      const btn = $('scanNow'); btn.disabled = true; btn.textContent = '抓取中…';
      const r = await send('xb/content/scan');
      btn.disabled = false; btn.textContent = '扫描当前可见页';
      if (r.ok) {
        if (r.data && r.data.skipped) toast(r.data.reason || '请在 x.com/i/bookmarks 打开页面');
        else {
          const d = r.data || {};
          if (!d.found) toast('页面暂未发现书签，请等待列表加载后重试');
          else toast('抓取完成：发现 ' + d.found + '，新增 ' + (d.added || 0) + '，更新 ' + (d.updated || 0));
          await loadAll();
          await refreshList();
        }
      } else toast(r.error, true);
    });
    $('fullSync').addEventListener('click', async () => {
      $('fullSync').disabled = true;
      const r = await send('xb/sync/start');
      if (!r.ok) toast(r.error, true);
      else toast(r.data && r.data.alreadyRunning ? '全量同步已在运行' : '全量同步已启动，可关闭本页');
      await refreshFullSyncStatus();
    });
    $('stopSync').addEventListener('click', async () => {
      $('stopSync').disabled = true;
      const r = await send('xb/sync/stop');
      $('stopSync').disabled = false;
      if (!r.ok) toast(r.error, true);
      await refreshFullSyncStatus();
    });
    $('aiRun').addEventListener('click', async () => {
      const btn = $('aiRun'); btn.disabled = true; btn.textContent = 'AI 思考中…';
      const r = await send('xb/ai/run', { limit: 50 });
      btn.disabled = false; btn.textContent = '✨ AI 整理未分类';
      if (r.ok) {
        if (!r.data || r.data.count === 0) toast('没有未分类的书签可整理');
        else { toast('AI 已生成 ' + r.data.count + ' 条建议'); setView('ai-pending'); }
      } else toast(r.error, true);
    });
    $('batchApply').addEventListener('click', () => {
      const catId = $('batchCat').value;
      if (!catId) { toast('先选一个分类', true); return; }
      assignCat(Array.from(state.selected), catId).then(() => { state.selected.clear(); });
    });
    $('batchIgnore').addEventListener('click', () => { ignore(Array.from(state.selected)).then(() => state.selected.clear()); });
    $('batchDelete').addEventListener('click', () => { remove(Array.from(state.selected)).then(() => state.selected.clear()); });
    $('batchClear').addEventListener('click', () => {
      state.selected.clear();
      qsa('.row').forEach((r) => { r.classList.remove('selected'); const cb = r.querySelector('[data-act="select"]'); if (cb) cb.checked = false; });
      updateBatchBar();
    });
    $('aiAcceptAll').addEventListener('click', () => {
      if (!currentBatch) return;
      currentBatch.enriched.forEach((it) => { batchDecisions[it.tweetId] = { action: 'accept' }; });
      renderAiList();
    });
    $('aiRejectAll').addEventListener('click', () => {
      if (!currentBatch) return;
      currentBatch.enriched.forEach((it) => { batchDecisions[it.tweetId] = { action: 'reject' }; });
      renderAiList();
    });
    $('aiClose').addEventListener('click', () => { $('aiDrawer').classList.add('hidden'); });
    $('aiApply').addEventListener('click', applyAi);

    $('exportBtn').addEventListener('click', exportData);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(String(reader.result));
          if (Array.isArray(data.categories) && data.categories.length) {
            for (const c of data.categories) {
              await send('xb/categories/create', { name: c.name, color: c.color, description: c.description });
            }
          }
          if (Array.isArray(data.bookmarks) && data.bookmarks.length) {
            await send('xb/bookmarks/upsert', { items: data.bookmarks });
          }
          if (Array.isArray(data.history) && data.history.length) {
            for (const h of data.history) await send('xb/history/record', { item: h });
          }
          toast('已导入');
          await loadAll(); await refreshList();
        } catch (err) {
          toast('导入失败：' + err.message, true);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    window.addEventListener('resize', window.XBUtil ? XBUtil.debounce(syncDashboardTopHeight, 120) : syncDashboardTopHeight);
  }

  async function init() {
    bind();
    await loadAll();
    if (window.location.hash === '#history') {
      state.view = 'history';
      qsa('.navItem').forEach((el) => el.classList.remove('active'));
      const active = qsa('.navItem').find((el) => el.dataset.view === 'history');
      if (active) active.classList.add('active');
    }
    await refreshList();
    setInterval(refreshFullSyncStatus, 1200);
  }

  init();
})();










