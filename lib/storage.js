// 数据层：所有读写都走 chrome.storage.local。
// 数据模型：
//   bookmarks: { [tweetId]: Bookmark }
//   categories: { [categoryId]: Category }
//   ai: { provider, apiKey, baseUrl, model, lastUsedAt, pending: { [batchId]: SuggestionBatch } }
//   history: { enabled, maxItems, items:{ [urlKey]: HistoryItem } }
//   meta: { lastSyncAt, version, fullSync }
//
// Bookmark = {
//   id, author:{name,handle}, text, url, tweetTime, capturedAt,
//   media:[{type,url}], categoryId|null, notes, manuallyRemoved
// }
// Category = { id, name, color, order, createdAt, description? }
// SuggestionBatch = { id, createdAt, items:[{tweetId, categoryId|null, categoryName?, reason}] }
// HistoryItem = { id, url, title, kind, label, firstSeenAt, lastSeenAt, visitCount }

(function (root) {
  'use strict';

  const KEY = 'xb_state_v1';
  const STORAGE_AREA = (root.chrome && root.chrome.storage && root.chrome.storage.local) ? root.chrome.storage.local : null;

  const DEFAULT_FULL_SYNC = {
    state: 'idle',
    pages: 0,
    fetched: 0,
    added: 0,
    updated: 0,
    cursor: null,
    tabId: null,
    error: null,
    warning: null,
    limited: false,
    startedAt: 0,
    completedAt: 0,
  };

  const DEFAULT_STATE = {
    bookmarks: {},
    categories: {},
    ai: {
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      customPrompt: '',
      lastUsedAt: 0,
      pending: {},
    },
    history: {
      enabled: true,
      maxItems: 2000,
      items: {},
    },
    meta: { lastSyncAt: 0, version: 1, fullSync: Object.assign({}, DEFAULT_FULL_SYNC) },
  };

  // 简易内存缓存，避免每次都打 storage。
  let _state = null;
  const _listeners = new Set();

  function _emit() {
    for (const fn of _listeners) {
      try { fn(_state); } catch (e) { console.error('[XB] listener error', e); }
    }
  }

  async function load() {
    if (_state) return _state;
    if (!STORAGE_AREA) {
      _state = JSON.parse(JSON.stringify(DEFAULT_STATE));
      return _state;
    }
    const got = await new Promise((resolve) => {
      STORAGE_AREA.get([KEY], (res) => resolve(res || {}));
    });
    const s = got[KEY];
    if (!s) {
      _state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    } else {
      _state = {
        bookmarks: s.bookmarks || {},
        categories: s.categories || {},
        ai: Object.assign({}, DEFAULT_STATE.ai, s.ai || {}),
        history: Object.assign({}, DEFAULT_STATE.history, s.history || {}),
        meta: Object.assign({}, DEFAULT_STATE.meta, s.meta || {}),
      };
      if (!_state.ai.pending) _state.ai.pending = {};
      if (!_state.history.items) _state.history.items = {};
      if (!_state.history.maxItems) _state.history.maxItems = DEFAULT_STATE.history.maxItems;
      _state.meta.fullSync = Object.assign({}, DEFAULT_FULL_SYNC, _state.meta.fullSync || {});
    }
    return _state;
  }

  async function _persist() {
    if (!STORAGE_AREA) return;
    await new Promise((resolve, reject) => {
      STORAGE_AREA.set({ [KEY]: _state }, () => {
        const err = root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        if (err) reject(err); else resolve();
      });
    });
    _emit();
  }

  function subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }

  // ---------- 分类 ----------

  async function createCategory({ name, color, description }) {
    const s = await load();
    const id = root.XBUtil.uid();
    const orderMax = Object.values(s.categories).reduce((m, c) => Math.max(m, c.order || 0), 0);
    s.categories[id] = {
      id,
      name: (name || '未命名').slice(0, 40),
      color: color || pickColor(id),
      order: orderMax + 1,
      description: description || '',
      createdAt: root.XBUtil.now(),
    };
    await _persist();
    return s.categories[id];
  }

  async function updateCategory(id, patch) {
    const s = await load();
    const c = s.categories[id];
    if (!c) throw new Error('分类不存在');
    if (patch.name != null) c.name = String(patch.name).slice(0, 40);
    if (patch.color != null) c.color = patch.color;
    if (patch.description != null) c.description = String(patch.description);
    if (patch.order != null) c.order = patch.order;
    await _persist();
    return c;
  }

  async function deleteCategory(id) {
    const s = await load();
    delete s.categories[id];
    for (const b of Object.values(s.bookmarks)) {
      if (b.categoryId === id) b.categoryId = null;
    }
    await _persist();
  }

  async function reorderCategories(orderedIds) {
    const s = await load();
    orderedIds.forEach((id, i) => {
      if (s.categories[id]) s.categories[id].order = i + 1;
    });
    await _persist();
  }

  // ---------- 书签 ----------

  async function upsertBookmarks(items) {
    const s = await load();
    let added = 0, updated = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const existed = s.bookmarks[it.id];
      if (!existed) {
        added++;
        s.bookmarks[it.id] = Object.assign(
          { capturedAt: root.XBUtil.now(), categoryId: null, notes: '', manuallyRemoved: false },
          it
        );
      } else {
        const preserved = {
          categoryId: existed.categoryId,
          notes: existed.notes,
          manuallyRemoved: existed.manuallyRemoved,
        };
        Object.assign(existed, it, preserved);
        updated++;
      }
    }
    s.meta.lastSyncAt = root.XBUtil.now();
    await _persist();
    return { added, updated };
  }

  async function assignCategory(tweetIds, categoryId) {
    const s = await load();
    let n = 0;
    for (const id of tweetIds) {
      const b = s.bookmarks[id];
      if (!b) continue;
      b.categoryId = categoryId || null;
      n++;
    }
    await _persist();
    return n;
  }

  async function setNotes(tweetId, notes) {
    const s = await load();
    const b = s.bookmarks[tweetId];
    if (!b) throw new Error('书签不存在');
    b.notes = String(notes || '');
    await _persist();
  }

  async function deleteBookmarks(tweetIds) {
    const s = await load();
    for (const id of tweetIds) delete s.bookmarks[id];
    await _persist();
  }

  async function markRemoved(tweetIds, removed = true) {
    const s = await load();
    for (const id of tweetIds) {
      const b = s.bookmarks[id];
      if (b) b.manuallyRemoved = !!removed;
    }
    await _persist();
  }

  // ---------- 全量同步状态 ----------

  async function getFullSyncStatus() {
    const s = await load();
    s.meta.fullSync = Object.assign({}, DEFAULT_FULL_SYNC, s.meta.fullSync || {});
    return Object.assign({}, s.meta.fullSync);
  }

  async function setFullSyncStatus(patch) {
    const s = await load();
    s.meta.fullSync = Object.assign({}, DEFAULT_FULL_SYNC, s.meta.fullSync || {}, patch || {});
    await _persist();
    return Object.assign({}, s.meta.fullSync);
  }

  // ---------- 浏览记录 ----------

  function normalizeHistoryInput(item) {
    if (!item || !item.url) return null;
    let url = String(item.url || '').trim();
    try {
      const u = new URL(url);
      if (!/^(x\.com|twitter\.com)$/i.test(u.hostname)) return null;
      u.hostname = 'x.com';
      u.hash = '';
      if (u.pathname !== '/search') u.search = '';
      else {
        const q = u.searchParams.get('q') || '';
        u.search = q ? ('?q=' + encodeURIComponent(q)) : '';
      }
      url = u.toString();
    } catch (_e) {
      return null;
    }
    const now = root.XBUtil.now();
    return {
      id: url,
      url,
      title: String(item.title || '').slice(0, 180),
      kind: String(item.kind || 'page').slice(0, 32),
      label: String(item.label || '').slice(0, 180),
      excerpt: String(item.excerpt || '').slice(0, 500),
      author: item.author || null,
      tweetId: item.tweetId ? String(item.tweetId) : null,
      firstSeenAt: Number(item.firstSeenAt) || now,
      lastSeenAt: Number(item.lastSeenAt) || now,
      visitCount: Math.max(1, Number(item.visitCount) || 1),
    };
  }

  async function recordHistoryVisit(item) {
    const s = await load();
    if (!s.history.enabled) return { recorded: false, disabled: true };
    const clean = normalizeHistoryInput(item);
    if (!clean) return { recorded: false, skipped: true };
    const existed = s.history.items[clean.id];
    if (existed) {
      existed.lastSeenAt = clean.lastSeenAt;
      existed.visitCount = Math.max(1, Number(existed.visitCount) || 1) + 1;
      existed.title = clean.title || existed.title || '';
      existed.kind = clean.kind || existed.kind || 'page';
      existed.label = clean.label || existed.label || '';
      existed.excerpt = clean.excerpt || existed.excerpt || '';
      existed.author = clean.author || existed.author || null;
      existed.tweetId = clean.tweetId || existed.tweetId || null;
    } else {
      s.history.items[clean.id] = clean;
    }

    const maxItems = Math.max(100, Math.min(Number(s.history.maxItems) || 2000, 10000));
    const arr = Object.values(s.history.items).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    for (const old of arr.slice(maxItems)) delete s.history.items[old.id];

    await _persist();
    return { recorded: true, item: s.history.items[clean.id], total: Object.keys(s.history.items).length };
  }

  async function listHistory({ search, kind, limit } = {}) {
    const s = await load();
    let arr = Object.values(s.history.items || {});
    if (kind) arr = arr.filter((h) => h.kind === kind);
    if (search) {
      const q = String(search).toLowerCase();
      arr = arr.filter((h) => {
        return (
          (h.title && h.title.toLowerCase().includes(q)) ||
          (h.label && h.label.toLowerCase().includes(q)) ||
          (h.excerpt && h.excerpt.toLowerCase().includes(q)) ||
          (h.url && h.url.toLowerCase().includes(q)) ||
          (h.author && h.author.handle && h.author.handle.toLowerCase().includes(q)) ||
          (h.author && h.author.name && h.author.name.toLowerCase().includes(q))
        );
      });
    }
    arr.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    const n = Math.max(1, Math.min(Number(limit) || 300, 10000));
    return arr.slice(0, n);
  }

  async function getHistoryConfig() {
    const s = await load();
    return {
      enabled: !!s.history.enabled,
      maxItems: Number(s.history.maxItems) || DEFAULT_STATE.history.maxItems,
      total: Object.keys(s.history.items || {}).length,
    };
  }

  async function setHistoryConfig(patch) {
    const s = await load();
    if (patch && patch.enabled != null) s.history.enabled = !!patch.enabled;
    if (patch && patch.maxItems != null) {
      s.history.maxItems = Math.max(100, Math.min(Number(patch.maxItems) || 2000, 10000));
    }
    await _persist();
    return getHistoryConfig();
  }

  async function deleteHistoryItems(ids) {
    const s = await load();
    let removed = 0;
    for (const id of ids || []) {
      if (s.history.items[id]) {
        delete s.history.items[id];
        removed++;
      }
    }
    await _persist();
    return removed;
  }

  async function clearHistory() {
    const s = await load();
    const removed = Object.keys(s.history.items || {}).length;
    s.history.items = {};
    await _persist();
    return { removed };
  }

  // ---------- AI ----------

  async function saveAiConfig(cfg) {
    const s = await load();
    Object.assign(s.ai, cfg);
    await _persist();
    return s.ai;
  }

  async function getAiConfig() {
    const s = await load();
    return s.ai;
  }

  async function addPendingBatch(batch) {
    const s = await load();
    s.ai.pending[batch.id] = batch;
    await _persist();
    return batch;
  }

  async function getPendingBatch(id) {
    const s = await load();
    return s.ai.pending[id] || null;
  }

  async function listPendingBatches() {
    const s = await load();
    return Object.values(s.ai.pending).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function dropPendingBatch(id) {
    const s = await load();
    delete s.ai.pending[id];
    await _persist();
  }

  async function applyPendingBatch(id, decisions) {
    // decisions: [{tweetId, action:'accept'|'reject'|'reassign', categoryId?}]
    const s = await load();
    const batch = s.ai.pending[id];
    if (!batch) throw new Error('批次不存在');
    const counts = { accept: 0, reject: 0, reassign: 0 };
    const newCatNameToId = {};
    for (const it of batch.items) {
      if (it.categoryName && !it.categoryId) {
        const name = it.categoryName.trim();
        if (!newCatNameToId[name]) {
          const existed = Object.values(s.categories).find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (existed) newCatNameToId[name] = existed.id;
          else {
            const c = await createCategory({ name });
            newCatNameToId[name] = c.id;
          }
        }
      }
    }
    for (const d of decisions) {
      const target = d.tweetId ? batch.items.find((x) => x.tweetId === d.tweetId) : null;
      if (d.action === 'accept') {
        let catId = d.categoryId || (target && target.categoryId) || null;
        if (!catId && target && target.categoryName) catId = newCatNameToId[target.categoryName] || null;
        if (catId) {
          await assignCategory([d.tweetId], catId);
          counts.accept++;
        }
      } else if (d.action === 'reassign' && d.categoryId) {
        await assignCategory([d.tweetId], d.categoryId);
        counts.reassign++;
      } else {
        counts.reject++;
      }
    }
    delete s.ai.pending[id];
    await _persist();
    return counts;
  }

  // ---------- 统计 / 列表 ----------

  function bookmarkCapturedAt(b) {
    const t = Number(b && b.capturedAt);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  function normalizeTimeSource(source) {
    return source === 'tweet' || source === 'tweetTime' ? 'tweet' : 'captured';
  }

  function rangeTime(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) && t > 0 ? t : null;
    }
    if (typeof v === 'string') {
      const localDay = parseDateKeyStart(v.trim());
      if (localDay != null) return localDay;
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(String(v));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function bookmarkTweetTime(b) {
    return rangeTime(b && b.tweetTime) || 0;
  }

  function bookmarkTime(b, source) {
    return normalizeTimeSource(source) === 'tweet' ? bookmarkTweetTime(b) : bookmarkCapturedAt(b);
  }

  function sortBookmarkTime(b, source) {
    return bookmarkTime(b, source) || bookmarkCapturedAt(b) || bookmarkTweetTime(b) || 0;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function parseDateKeyStart(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const day = Number(m[3]);
    const d = new Date(y, mo, day);
    if (isNaN(d) || d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
    return d.getTime();
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function addDays(ms, n) {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function dateParts(ms) {
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
    };
  }

  function dateKey(ms) {
    const p = dateParts(ms);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }

  function monthKey(ms) {
    const p = dateParts(ms);
    return p.year + '-' + pad2(p.month);
  }

  function yearKey(ms) {
    return String(dateParts(ms).year);
  }

  function halfKey(ms) {
    const p = dateParts(ms);
    return p.year + '-H' + (p.month <= 6 ? '1' : '2');
  }

  function biweekKey(ms) {
    const p = dateParts(ms);
    return p.year + '-B' + pad2((p.month - 1) * 2 + (p.day <= 15 ? 0 : 1) + 1);
  }

  function weekStart(ms) {
    const d = new Date(startOfDay(ms));
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d.getTime();
  }

  function weekKey(ms) {
    return dateKey(weekStart(ms));
  }

  function bucketLabel(groupBy, key) {
    if (groupBy === 'year') return key + ' 年';
    if (groupBy === 'biweek') {
      const m = /^(\d{4})-B(\d{2})$/.exec(String(key || ''));
      if (!m) return key;
      const halfMonth = Number(m[2]);
      const monthNum = Math.ceil(halfMonth / 2);
      const part = halfMonth % 2 === 1 ? '上半月' : '下半月';
      return m[1] + ' 年 ' + monthNum + ' 月 ' + part;
    }
    if (groupBy === 'half') {
      const m = /^(\d{4})-H([12])$/.exec(String(key || ''));
      if (!m) return key;
      return m[1] + (m[2] === '1' ? ' 上半年' : ' 下半年');
    }
    if (groupBy === 'month') {
      const parts = key.split('-');
      return parts[0] + ' 年 ' + Number(parts[1]) + ' 月';
    }
    if (groupBy === 'week') return key + ' 当周';
    if (groupBy === 'day') return key;
    return key;
  }

  function bucketRange(groupBy, key) {
    let m;
    if (groupBy === 'year') {
      const y = Number(key);
      if (!Number.isFinite(y)) return {};
      return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
    }
    if (groupBy === 'biweek') {
      m = /^(\d{4})-B(\d{2})$/.exec(String(key || ''));
      if (!m) return {};
      const y = Number(m[1]);
      const halfMonth = Number(m[2]);
      const monthNum = Math.ceil(halfMonth / 2);
      const mo = monthNum - 1;
      const isFirstHalf = halfMonth % 2 === 1;
      const from = new Date(y, mo, isFirstHalf ? 1 : 16).getTime();
      const to = isFirstHalf ? new Date(y, mo, 16).getTime() : new Date(y, mo + 1, 1).getTime();
      return { from, to };
    }
    if (groupBy === 'half') {
      m = /^(\d{4})-H([12])$/.exec(String(key || ''));
      if (!m) return {};
      const y = Number(m[1]);
      const mo = m[2] === '1' ? 0 : 6;
      return { from: new Date(y, mo, 1).getTime(), to: new Date(y, mo + 6, 1).getTime() };
    }
    if (groupBy === 'month') {
      m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
      if (!m) return {};
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      return { from: new Date(y, mo, 1).getTime(), to: new Date(y, mo + 1, 1).getTime() };
    }
    if (groupBy === 'week') {
      const from = parseDateKeyStart(key);
      if (!from) return {};
      return { from, to: addDays(from, 7) };
    }
    if (groupBy === 'day') {
      const from = parseDateKeyStart(key);
      if (!from) return {};
      return { from, to: addDays(from, 1) };
    }
    return {};
  }

  function bucketKey(groupBy, ms) {
    if (groupBy === 'day') return dateKey(ms);
    if (groupBy === 'week') return weekKey(ms);
    if (groupBy === 'biweek') return biweekKey(ms);
    if (groupBy === 'month') return monthKey(ms);
    if (groupBy === 'half') return halfKey(ms);
    return yearKey(ms);
  }

  function chooseAutoGroup(fromMs, toMs) {
    if (!fromMs || !toMs || toMs <= fromMs) return 'year';
    const days = Math.ceil((toMs - fromMs) / DAY_MS);
    if (days <= 45) return 'day';
    if (days <= 370) return 'week';
    if (days <= 365 * 2) return 'biweek';
    if (days <= 365 * 3) return 'month';
    if (days <= 365 * 10) return 'half';
    return 'year';
  }

  function filterBookmarks(s, { categoryId, search, includeRemoved, removedOnly, from, to, timeSource, authorId } = {}) {
    let arr = Object.values(s.bookmarks);
    if (removedOnly) arr = arr.filter((b) => b.manuallyRemoved);
    else if (!includeRemoved) arr = arr.filter((b) => !b.manuallyRemoved);
    if (categoryId === 'uncategorized') arr = arr.filter((b) => !b.categoryId);
    else if (categoryId) arr = arr.filter((b) => b.categoryId === categoryId);
    if (search) {
      const q = String(search).toLowerCase();
      arr = arr.filter((b) => {
        return (
          (b.text && b.text.toLowerCase().includes(q)) ||
          (b.author && b.author.name && b.author.name.toLowerCase().includes(q)) ||
          (b.author && b.author.handle && b.author.handle.toLowerCase().includes(q)) ||
          (b.notes && b.notes.toLowerCase().includes(q))
        );
      });
    }

    const fromMs = rangeTime(from);
    const toMs = rangeTime(to);
    if (fromMs != null || toMs != null) {
      const source = normalizeTimeSource(timeSource);
      arr = arr.filter((b) => {
        const t = bookmarkTime(b, source);
        if (!t) return false;
        if (fromMs != null && t < fromMs) return false;
        if (toMs != null && t >= toMs) return false;
        return true;
      });
    }
    if (authorId) {
      const aid = String(authorId).toLowerCase().replace(/^@/, '');
      arr = arr.filter((b) => {
        const h = b.author && b.author.handle ? String(b.author.handle).toLowerCase() : '';
        return h === aid;
      });
    }
    return arr;
  }

  async function listBookmarks({ categoryId, search, includeRemoved, removedOnly, limit, offset, page, from, to, timeSource, authorId } = {}) {
    const s = await load();
    const source = normalizeTimeSource(timeSource);
    const arr = filterBookmarks(s, { categoryId, search, includeRemoved, removedOnly, from, to, timeSource: source, authorId });
    arr.sort((a, b) => sortBookmarkTime(b, source) - sortBookmarkTime(a, source));

    const total = arr.length;
    if (page || limit != null || offset != null) {
      const n = Math.max(1, Math.min(Number(limit) || 80, 500));
      const fromIndex = Math.max(0, Number(offset) || 0);
      return {
        items: arr.slice(fromIndex, fromIndex + n),
        total,
        offset: fromIndex,
        limit: n,
      };
    }
    return arr;
  }

  async function getBookmarkTimeStats({ categoryId, search, includeRemoved, removedOnly, from, to, groupBy, heatmapYear, timeSource, authorId = null } = {}) {
    const s = await load();
    const source = normalizeTimeSource(timeSource);
    const arr = filterBookmarks(s, { categoryId, search, includeRemoved, removedOnly, from, to, timeSource: source, authorId });
    const wanted = ['auto', 'year', 'half', 'biweek', 'month', 'week', 'day'].includes(groupBy) ? groupBy : 'auto';
    const requestedHeatYear = Number(heatmapYear);
    let heatYear = Number.isFinite(requestedHeatYear) && requestedHeatYear > 0 ? requestedHeatYear : null;

    const dayCounts = new Map();
    const heatCounts = new Map();
    const bucketCounts = new Map();
    let timedTotal = 0;
    let minTime = null;
    let maxTime = null;

    for (const b of arr) {
      const t = bookmarkTime(b, source);
      if (!t) continue;
      timedTotal++;
      minTime = minTime == null ? t : Math.min(minTime, t);
      maxTime = maxTime == null ? t : Math.max(maxTime, t);
      const dKey = dateKey(t);
      dayCounts.set(dKey, (dayCounts.get(dKey) || 0) + 1);
    }

    const fromMs = rangeTime(from);
    const toMs = rangeTime(to);
    const rangeFrom = fromMs != null ? fromMs : minTime;
    const rangeTo = toMs != null ? toMs : (maxTime != null ? maxTime + 1 : null);
    const group = wanted === 'auto' ? chooseAutoGroup(rangeFrom, rangeTo) : wanted;

    for (const b of arr) {
      const t = bookmarkTime(b, source);
      if (!t) continue;
      const key = bucketKey(group, t);
      bucketCounts.set(key, (bucketCounts.get(key) || 0) + 1);
    }

    let maxDay = null;
    for (const [key, count] of dayCounts.entries()) {
      if (!maxDay || count > maxDay.count) maxDay = { date: key, count };
    }

    if (!heatYear) heatYear = maxTime != null ? dateParts(maxTime).year : new Date().getFullYear();
    const heatPrefix = heatYear + '-';
    for (const [key, count] of dayCounts.entries()) {
      if (key.startsWith(heatPrefix)) heatCounts.set(key, count);
    }

    let maxBucket = null;
    const buckets = Array.from(bucketCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => {
        const range = bucketRange(group, key);
        const item = {
          key,
          label: bucketLabel(group, key),
          count,
          from: range.from || null,
          to: range.to || null,
          groupBy: group,
        };
        if (!maxBucket || count > maxBucket.count) maxBucket = item;
        return item;
      });

    return {
      total: timedTotal,
      untimed: arr.length - timedTotal,
      activeDays: dayCounts.size,
      maxDay,
      maxBucket,
      groupBy: group,
      timeSource: source,
      heatmapYear: heatYear,
      range: { from: rangeFrom, to: rangeTo },
      daily: Array.from(heatCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count })),
      buckets,
    };
  }

  function distinctAuthors(arr) {
    const set = new Set();
    for (const b of arr) {
      const h = b.author && b.author.handle ? String(b.author.handle).toLowerCase() : '';
      if (h) set.add(h);
    }
    return set.size;
  }

    async function getAuthorStats({ includeRemoved, search } = {}) {
    const s = await load();
    const arr = filterBookmarks(s, { includeRemoved, search });
    const map = new Map(); // handle -> aggregate
    for (const b of arr) {
      const a = b.author || {};
      const handle = a.handle ? String(a.handle).toLowerCase() : ('@noid:' + (b.id || ''));
      if (handle === '@noid:' + (b.id || '') && !a.name) continue; // skip fully empty authors
      const entry = map.get(handle) || {
        handle: a.handle || '',
        name: a.name || '',
        avatar: '',
        description: '',
        profileBanner: '',
        verified: false,
        followers: 0,
        following: 0,
        statuses: 0,
        mediaCount: 0,
        count: 0,
        latest: 0,
        latestTweetTime: 0,
        categorized: 0,
      };
      entry.count += 1;
      if (b.categoryId) entry.categorized += 1;
      const t = bookmarkTime(b, 'tweet') || bookmarkTime(b, 'captured') || 0;
      if (t > entry.latest) entry.latest = t;
      // Track the most recent tweet-time snapshot to surface freshest profile stats.
      const tt = bookmarkTime(b, 'tweet') || 0;
      if (tt && tt >= entry.latestTweetTime) {
        entry.latestTweetTime = tt;
        // Only overwrite profile metadata from the freshest snapshot that actually has it.
        if (a.followers) entry.followers = a.followers;
        if (a.statuses) entry.statuses = a.statuses;
        if (a.following) entry.following = a.following;
        if (a.mediaCount) entry.mediaCount = a.mediaCount;
        if (a.verified) entry.verified = true;
        if (a.avatar) entry.avatar = a.avatar;
        if (a.description) entry.description = a.description;
        if (a.profileBanner) entry.profileBanner = a.profileBanner;
      }
      if (!entry.name && a.name) entry.name = a.name;
      if (!entry.handle && a.handle) entry.handle = a.handle;
      map.set(handle, entry);
    }
    const authors = Array.from(map.values()).sort((a, b) => b.count - a.count || (b.latest || 0) - (a.latest || 0));
    return {
      total: arr.length,
      authors,
      authorCount: authors.length,
    };
  }
  async function getStats() {
    const s = await load();
    const cats = Object.values(s.categories).sort((a, b) => (a.order || 0) - (b.order || 0));
    const all = Object.values(s.bookmarks).filter((b) => !b.manuallyRemoved);
    const byCat = new Map();
    byCat.set('uncategorized', 0);
    for (const c of cats) byCat.set(c.id, 0);
    for (const b of all) {
      const key = b.categoryId || 'uncategorized';
      byCat.set(key, (byCat.get(key) || 0) + 1);
    }
    return {
      total: all.length,
      removed: Object.values(s.bookmarks).length - all.length,
      pendingAi: Object.keys(s.ai.pending).length,
      lastSyncAt: s.meta.lastSyncAt,
      historyTotal: Object.keys(s.history.items || {}).length,
      historyEnabled: !!s.history.enabled,
      categories: cats.map((c) => ({ id: c.id, name: c.name, color: c.color, count: byCat.get(c.id) || 0 })),
      uncategorizedCount: byCat.get('uncategorized') || 0,
      authorCount: distinctAuthors(all),
    };
  }

  // ---------- 工具 ----------

  const PALETTE = ['#1d9bf0', '#f91880', '#7856ff', '#00ba7c', '#f7b928', '#f4212e', '#5b7083', '#ffd400'];
  function pickColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  const api = {
    load, subscribe,
    createCategory, updateCategory, deleteCategory, reorderCategories,
    upsertBookmarks, assignCategory, setNotes, deleteBookmarks, markRemoved,
    getFullSyncStatus, setFullSyncStatus,
    recordHistoryVisit, listHistory, getHistoryConfig, setHistoryConfig, deleteHistoryItems, clearHistory,
    saveAiConfig, getAiConfig,
    addPendingBatch, getPendingBatch, listPendingBatches, dropPendingBatch, applyPendingBatch,
    listBookmarks, getBookmarkTimeStats, getAuthorStats, getStats,
  };

  root.XBStore = api;
})(typeof self !== 'undefined' ? self : globalThis);












