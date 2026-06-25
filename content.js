// content script：跑在 x.com/i/bookmarks 页面。
// 责任：观察 DOM、抽出推文、增量推给 background 去入库。
// 关键原则：永远不抛错；用消息通道而不是 storage 直写，避免和 popup/options 抢写。

(function () {
  'use strict';
  if (!window.XBScraper || !window.XBUtil) return;

  let debounceTimer = null;
  let scanPromise = null;
  let fullSyncJob = null;
  let lastHistoryUrl = '';
  let lastHistoryAt = 0;
  const seenInThisPage = new Set();

  function isBookmarksPage() {
    return /^\/i\/bookmarks(?:\/|$)/.test(window.location.pathname);
  }

  function isXPage() {
    return /^(x\.com|twitter\.com)$/i.test(window.location.hostname || '');
  }

  function canonicalVisitUrl() {
    try {
      const u = new URL(window.location.href);
      if (!/^(x\.com|twitter\.com)$/i.test(u.hostname)) return null;
      u.hostname = 'x.com';
      u.hash = '';
      if (u.pathname === '/search') {
        const q = u.searchParams.get('q') || '';
        u.search = q ? ('?q=' + encodeURIComponent(q)) : '';
      } else {
        u.search = '';
      }
      return u.toString();
    } catch (_e) {
      return null;
    }
  }

  function describeVisit(url) {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings']);
    let kind = 'page';
    let label = 'X 页面';
    let tweetId = null;

    const status = path.match(/^\/([^/]+)\/status\/(\d+)/);
    if (status) {
      kind = 'tweet';
      label = '推文 @' + status[1];
      tweetId = status[2];
    } else if (path === '/' || path === '/home') {
      kind = 'home';
      label = '首页';
    } else if (path === '/i/bookmarks') {
      kind = 'bookmarks';
      label = '书签页';
    } else if (path === '/notifications') {
      kind = 'notifications';
      label = '通知';
    } else if (path === '/messages') {
      kind = 'messages';
      label = '私信';
    } else if (path === '/explore') {
      kind = 'explore';
      label = '探索';
    } else if (path === '/search') {
      kind = 'search';
      label = '搜索：' + (u.searchParams.get('q') || '');
    } else {
      const profile = path.match(/^\/([^/]+)$/);
      if (profile && !reserved.has(profile[1])) {
        kind = 'profile';
        label = '用户主页 @' + profile[1];
      } else {
        label = path;
      }
    }

    return { kind, label, tweetId };
  }

  function activeTweetSnapshot(tweetId) {
    if (!tweetId || !window.XBScraper) return null;
    try {
      return window.XBScraper.scanOnce().find((it) => it.id === tweetId) || null;
    } catch (_e) {
      return null;
    }
  }

  function collectHistoryVisit() {
    if (!isXPage()) return null;
    const url = canonicalVisitUrl();
    if (!url) return null;
    const info = describeVisit(url);
    const item = {
      url,
      title: String(document.title || '').replace(/\s*\/\s*X\s*$/, '').slice(0, 180),
      kind: info.kind,
      label: info.label,
      tweetId: info.tweetId || null,
    };
    const tweet = activeTweetSnapshot(info.tweetId);
    if (tweet) {
      item.excerpt = tweet.text || '';
      item.author = tweet.author || null;
      if (tweet.author && tweet.author.handle) item.label = '推文 @' + tweet.author.handle;
    }
    return item;
  }

  async function recordCurrentPage(force) {
    const item = collectHistoryVisit();
    if (!item) return;
    const now = Date.now();
    if (!force && item.url === lastHistoryUrl && now - lastHistoryAt < 60000) return;
    lastHistoryUrl = item.url;
    lastHistoryAt = now;
    try {
      await chrome.runtime.sendMessage({ type: 'xb/history/record', item });
    } catch (_e) {}
  }

  const scheduleHistoryRecord = window.XBUtil.debounce(() => { recordCurrentPage(false); }, 900);

  function installRouteWatcher() {
    if (window.__xbHistoryRouteWatcherInstalled) return;
    window.__xbHistoryRouteWatcherInstalled = true;

    const notifyRoute = () => {
      scheduleHistoryRecord();
      if (isBookmarksPage()) scheduleScan();
    };

    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      if (typeof original !== 'function') continue;
      history[name] = function () {
        const ret = original.apply(this, arguments);
        setTimeout(notifyRoute, 0);
        return ret;
      };
    }
    window.addEventListener('popstate', notifyRoute);
    window.addEventListener('hashchange', notifyRoute);

    const target = document.body || document.documentElement;
    if (target) {
      const mo = new MutationObserver(window.XBUtil.debounce(scheduleHistoryRecord, 800));
      mo.observe(target, { childList: true, subtree: true });
    }
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { scanAndSend(); }, 400);
  }

  function scanAndSend() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      if (!isBookmarksPage()) {
        return { ok: false, error: '当前不是 X 书签页' };
      }

      const items = window.XBScraper.scanOnce();
      const fresh = items.filter((it) => !seenInThisPage.has(it.id));
      if (fresh.length === 0) {
        return { ok: true, data: { found: items.length, attempted: 0, added: 0, updated: 0 } };
      }

      try {
        const response = await chrome.runtime.sendMessage({ type: 'xb/bookmarks/upsert', items: fresh });
        if (!response || response.ok === false) {
          return { ok: false, error: (response && response.error) || '后台未确认入库' };
        }

        // 只有后台确认写入后才标记为已见；临时失败的条目可以再次抓取。
        fresh.forEach((it) => seenInThisPage.add(it.id));
        const saved = response.data || {};
        return {
          ok: true,
          data: {
            found: items.length,
            attempted: fresh.length,
            added: Number(saved.added) || 0,
            updated: Number(saved.updated) || 0,
          },
        };
      } catch (e) {
        return { ok: false, error: '入库失败：' + String((e && e.message) || e) };
      }
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  function installObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;
    const mo = new MutationObserver(window.XBUtil.debounce(scheduleScan, 250));
    // 观察 body 可覆盖 X 的 SPA 路由切换和 main 节点整体替换。
    mo.observe(target, { childList: true, subtree: true });
  }

  async function runFullSync(job) {
    try {
      const result = await window.XBXApi.syncAll({
        shouldStop: () => job.cancelled,
        onPage: async (page) => {
          const response = await chrome.runtime.sendMessage({
            type: 'xb/sync/page',
            page: page.page,
            fetched: page.fetched,
            items: page.items,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          });
          if (!response || response.ok === false) {
            throw new Error((response && response.error) || '后台写入分页失败');
          }
        },
      });
      await chrome.runtime.sendMessage({
        type: 'xb/sync/complete',
        stopped: !!result.stopped,
        pages: result.page,
        fetched: result.fetched,
        limited: !!result.limited,
        warning: result.warning || null,
      });
    } catch (e) {
      try {
        await chrome.runtime.sendMessage({
          type: 'xb/sync/error',
          error: String((e && e.message) || e),
        });
      } catch (_ignored) {}
    } finally {
      if (fullSyncJob === job) fullSyncJob = null;
    }
  }

  // 接收 popup/options 触发的命令
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'xb/content/scan') {
      scanAndSend().then(sendResponse);
      return true;
    }
    if (msg.type === 'xb/content/autoScroll') {
      (async () => {
        await window.XBScraper.autoScroll(msg.options || {});
        sendResponse(await scanAndSend());
      })();
      return true;
    }
    if (msg.type === 'xb/content/fullSyncStart') {
      if (!window.XBXApi) {
        sendResponse({ ok: false, error: '全量同步模块未加载，请重新加载插件并刷新 X 页面' });
        return;
      }
      if (fullSyncJob) {
        sendResponse({ ok: true, data: { alreadyRunning: true } });
        return;
      }
      fullSyncJob = { cancelled: false };
      sendResponse({ ok: true, data: { started: true } });
      runFullSync(fullSyncJob);
      return;
    }
    if (msg.type === 'xb/content/fullSyncStop') {
      if (fullSyncJob) fullSyncJob.cancelled = true;
      sendResponse({ ok: true, data: { stopping: !!fullSyncJob } });
      return;
    }
  });

  // 启动
  function boot() {
    installObserver();
    installRouteWatcher();
    // 首屏已经渲染好的先抓一次，同时记录当前 X 页面访问。
    scheduleHistoryRecord();
    if (isBookmarksPage()) scheduleScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
