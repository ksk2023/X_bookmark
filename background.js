// service worker：消息中枢。
// lib/* 同时被 content script 以普通脚本加载，因此它们采用 IIFE 挂到
// globalThis；这里使用经典 service worker 的 importScripts 复用同一套模块。

importScripts('./lib/util.js', './lib/storage.js', './lib/ai.js');

const { XBAI, XBStore, XBUtil } = globalThis;
if (!XBAI || !XBStore || !XBUtil) {
  throw new Error('X Bookmark Organizer 后台模块加载失败');
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage?.();
  }
});

async function withError(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    console.error('[XB] handler error', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    let result;
    switch (msg.type) {
      case 'xb/bookmarks/upsert': {
        result = await withError(() => XBStore.upsertBookmarks(msg.items || []));
        break;
      }
      case 'xb/bookmarks/list': {
        result = await withError(() => XBStore.listBookmarks(msg.query || {}));
        break;
      }
      case 'xb/bookmarks/timeStats': {
        result = await withError(() => XBStore.getBookmarkTimeStats(msg.query || {}));
        break;
      }
      case 'xb/authors/stats': {
        result = await withError(() => XBStore.getAuthorStats(msg.query || {}));
        break;
      }
      case 'xb/stats': {
        result = await withError(() => XBStore.getStats());
        break;
      }
      case 'xb/categories/list': {
        result = await withError(async () => {
          const s = await XBStore.load();
          return Object.values(s.categories).sort((a, b) => (a.order || 0) - (b.order || 0));
        });
        break;
      }
      case 'xb/categories/create': {
        result = await withError(() => XBStore.createCategory(msg));
        break;
      }
      case 'xb/categories/update': {
        result = await withError(() => XBStore.updateCategory(msg.id, msg.patch || {}));
        break;
      }
      case 'xb/categories/delete': {
        result = await withError(() => XBStore.deleteCategory(msg.id));
        break;
      }
      case 'xb/categories/reorder': {
        result = await withError(() => XBStore.reorderCategories(msg.orderedIds || []));
        break;
      }
      case 'xb/bookmarks/assign': {
        result = await withError(() => XBStore.assignCategory(msg.tweetIds || [], msg.categoryId || null));
        break;
      }
      case 'xb/bookmarks/setNotes': {
        result = await withError(() => XBStore.setNotes(msg.tweetId, msg.notes || ''));
        break;
      }
      case 'xb/bookmarks/delete': {
        result = await withError(() => XBStore.deleteBookmarks(msg.tweetIds || []));
        break;
      }
      case 'xb/bookmarks/markRemoved': {
        result = await withError(() => XBStore.markRemoved(msg.tweetIds || [], !!msg.removed));
        break;
      }
      case 'xb/ai/config': {
        result = await withError(async () => {
          if (msg.patch) await XBStore.saveAiConfig(msg.patch);
          const cfg = await XBStore.getAiConfig();
          return { ...cfg, apiKey: cfg.apiKey ? '\u2022\u2022\u2022\u2022' + cfg.apiKey.slice(-4) : '' };
        });
        break;
      }
      case 'xb/ai/ping': {
        result = await withError(async () => {
          const cfg = await XBStore.getAiConfig();
          const reply = await XBAI.ping(cfg);
          return { reply };
        });
        break;
      }
      case 'xb/ai/run': {
        result = await withError(async () => {
          const cfg = await XBStore.getAiConfig();
          if (!cfg.apiKey) throw new Error('请先在选项页配置 API Key');
          const all = await XBStore.listBookmarks({ categoryId: 'uncategorized' });
          const limit = Math.max(1, Math.min(msg.limit || 50, 200));
          const items = all.slice(0, limit);
          if (items.length === 0) return { batchId: null, count: 0 };
          const s = await XBStore.load();
          const cats = Object.values(s.categories).sort((a, b) => (a.order || 0) - (b.order || 0));
          const suggestions = await XBAI.suggestCategories(cfg, items, cats);
          const batch = {
            id: XBUtil.uid(),
            createdAt: XBUtil.now(),
            items: suggestions.map((sg) => ({
              tweetId: sg.tweetId,
              categoryId: sg.categoryId,
              categoryName: sg.categoryName,
              reason: sg.reason,
            })),
          };
          await XBStore.addPendingBatch(batch);
          await XBStore.saveAiConfig({ lastUsedAt: XBUtil.now() });
          return { batchId: batch.id, count: batch.items.length };
        });
        break;
      }
      case 'xb/ai/pendingList': {
        result = await withError(() => XBStore.listPendingBatches());
        break;
      }
      case 'xb/ai/pendingGet': {
        result = await withError(async () => {
          const batch = await XBStore.getPendingBatch(msg.batchId);
          if (!batch) return null;
          const items = await XBStore.listBookmarks({ includeRemoved: true });
          const byId = new Map(items.map((b) => [b.id, b]));
          return {
            ...batch,
            enriched: batch.items.map((it) => {
              const b = byId.get(it.tweetId);
              if (!b) return { ...it, bookmark: null };
              return {
                ...it,
                bookmark: {
                  id: b.id,
                  text: b.text,
                  author: b.author,
                  url: b.url,
                  tweetTime: b.tweetTime,
                },
              };
            }),
          };
        });
        break;
      }
      case 'xb/ai/apply': {
        result = await withError(() => XBStore.applyPendingBatch(msg.batchId, msg.decisions || []));
        break;
      }
      case 'xb/ai/drop': {
        result = await withError(() => XBStore.dropPendingBatch(msg.batchId));
        break;
      }
      case 'xb/sync/start': {
        result = await withError(async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = tabs[0];
          if (!tab || !tab.id || !tab.url || !/^https:\/\/x\.com\//.test(tab.url)) {
            throw new Error('请先打开已登录的 x.com 页面');
          }
          const current = await XBStore.getFullSyncStatus();
          if ((current.state === 'starting' || current.state === 'running' || current.state === 'stopping') &&
              Date.now() - Number(current.startedAt || 0) < 30 * 60 * 1000) {
            return Object.assign({ alreadyRunning: true }, current);
          }
          const status = await XBStore.setFullSyncStatus({
            state: 'starting',
            pages: 0,
            fetched: 0,
            added: 0,
            updated: 0,
            cursor: null,
            tabId: tab.id,
            error: null,
            warning: null,
            limited: false,
            startedAt: Date.now(),
            completedAt: 0,
          });
          try {
            const reply = await chrome.tabs.sendMessage(tab.id, { type: 'xb/content/fullSyncStart' });
            if (!reply || reply.ok === false) throw new Error((reply && reply.error) || '书签同步器没有响应');
          } catch (e) {
            await XBStore.setFullSyncStatus({
              state: 'error',
              error: '无法启动全量同步：' + String((e && e.message) || e) + '。请重新加载插件并刷新 X 页面。',
              completedAt: Date.now(),
            });
            throw e;
          }
          return status;
        });
        break;
      }
      case 'xb/sync/status': {
        result = await withError(() => XBStore.getFullSyncStatus());
        break;
      }
      case 'xb/sync/page': {
        result = await withError(async () => {
          const status = await XBStore.getFullSyncStatus();
          if (status.tabId && sender.tab && status.tabId !== sender.tab.id) {
            throw new Error('忽略了来自非同步标签页的数据');
          }
          const saved = await XBStore.upsertBookmarks(msg.items || []);
          const next = await XBStore.setFullSyncStatus({
            state: 'running',
            pages: Number(msg.page) || status.pages,
            fetched: Number(msg.fetched) || status.fetched,
            added: Number(status.added || 0) + Number(saved.added || 0),
            updated: Number(status.updated || 0) + Number(saved.updated || 0),
            cursor: msg.nextCursor || null,
            error: null,
            warning: null,
          });
          return { saved, status: next };
        });
        break;
      }
      case 'xb/sync/complete': {
        const warning = msg.warning || (msg.limited
          ? 'X 返回了重复分页游标；已保存本次拿到的书签，没有继续请求以避免循环。可以稍后再次同步补齐。'
          : null);
        result = await withError(async () => XBStore.setFullSyncStatus({
          state: msg.stopped ? 'stopped' : 'completed',
          pages: Number(msg.pages) || undefined,
          fetched: Number(msg.fetched) || undefined,
          cursor: null,
          error: null,
          warning,
          limited: !!msg.limited,
          completedAt: Date.now(),
        }));
        break;
      }
      case 'xb/sync/error': {
        result = await withError(() => XBStore.setFullSyncStatus({
          state: 'error',
          error: String(msg.error || '未知同步错误'),
          warning: null,
          limited: false,
          completedAt: Date.now(),
        }));
        break;
      }
      case 'xb/sync/stop': {
        result = await withError(async () => {
          const status = await XBStore.getFullSyncStatus();
          if (!status.tabId || !['starting', 'running', 'stopping'].includes(status.state)) return status;
          await XBStore.setFullSyncStatus({ state: 'stopping' });
          try {
            await chrome.tabs.sendMessage(status.tabId, { type: 'xb/content/fullSyncStop' });
          } catch (e) {
            return XBStore.setFullSyncStatus({
              state: 'stopped',
              error: '同步标签页已关闭',
              completedAt: Date.now(),
            });
          }
          return XBStore.getFullSyncStatus();
        });
        break;
      }
      case 'xb/content/scan': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tabLoop: {
          const tab = tabs[0];
          if (!tab || !tab.url || !/^https:\/\/(x|twitter)\.com\/i\/bookmarks/.test(tab.url)) {
            result = { ok: true, data: { skipped: true, reason: '当前不是书签页' } };
            break tabLoop;
          }
          try {
            const r = await chrome.tabs.sendMessage(tab.id, { type: 'xb/content/scan' });
            result = r && r.ok === false
              ? { ok: false, error: r.error || '书签页扫描失败' }
              : { ok: true, data: (r && r.data) || r || {} };
          } catch (e) {
            result = { ok: false, error: '无法与书签页通信：' + ((e && e.message) || e) };
          }
        }
        break;
      }
      case 'xb/history/record': {
        result = await withError(() => XBStore.recordHistoryVisit(msg.item || {}));
        break;
      }
      case 'xb/history/list': {
        result = await withError(() => XBStore.listHistory(msg.query || {}));
        break;
      }
      case 'xb/history/config': {
        result = await withError(async () => {
          if (msg.patch) await XBStore.setHistoryConfig(msg.patch);
          return XBStore.getHistoryConfig();
        });
        break;
      }
      case 'xb/history/delete': {
        result = await withError(() => XBStore.deleteHistoryItems(msg.ids || []));
        break;
      }
      case 'xb/history/clear': {
        result = await withError(() => XBStore.clearHistory());
        break;
      }
      case 'xb/content/autoScroll': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab || !tab.url || !/^https:\/\/(x|twitter)\.com\/i\/bookmarks/.test(tab.url)) {
          result = { ok: false, error: '请先打开 x.com/i/bookmarks' };
          break;
        }
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'xb/content/autoScroll', options: msg.options || {} });
          result = r && r.ok === false
            ? { ok: false, error: r.error || '自动滚动扫描失败' }
            : { ok: true, data: (r && r.data) || r || {} };
        } catch (e) {
          result = { ok: false, error: '无法与书签页通信：' + ((e && e.message) || e) };
        }
        break;
      }
      case 'xb/bookmarks/manualAdd': {
        result = await withError(async () => {
          const url = String(msg.url || '').trim();
          if (!/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url)) {
            throw new Error('请输入形如 https://x.com/<user>/status/<id> 的推文链接');
          }
          const m = url.match(/status\/(\d+)/);
          const id = m[1];
          const synd = 'https://cdn.syndication.twimg.com/tweet-result?id=' + id + '&lang=zh';
          const r = await fetch(synd, { credentials: 'omit' });
          if (!r.ok) throw new Error('syndication 接口返回 ' + r.status);
          const t = await r.json();
          const item = {
            id: String(t.id_str || id),
            url,
            author: {
              name: (t.user && t.user.name) || '',
              handle: (t.user && t.user.screen_name) || '',
              avatar: (t.user && t.user.profile_image_url_https) || '',
            },
            text: t.text || t.full_text || '',
            tweetTime: t.created_at || null,
            media: Array.isArray((t.entities && t.entities.media))
              ? t.entities.media.map(function (mm) {
                  return { type: (mm.type === 'video' || mm.type === 'animated_gif') ? 'video' : 'photo', url: mm.media_url_https };
                })
              : [],
          };
          const r2 = await XBStore.upsertBookmarks([item]);
          return Object.assign({ item: item }, r2);
        });
        break;
      }
      default:
        result = { ok: false, error: '未知消息类型：' + msg.type };
    }
    sendResponse(result);
  })();
  return true;
});
