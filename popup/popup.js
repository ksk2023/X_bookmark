// popup：把 chrome.runtime.sendMessage 当 RPC 用，所有真活都让 background 干。

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let lastSyncState = '';
  const toast = (msg, isError) => {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    setTimeout(() => { el.className = 'toast hidden'; }, 2400);
  };

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(r || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  async function refresh() {
    const r = await send('xb/stats');
    if (!r.ok) { toast(r.error, true); return; }
    const s = r.data;
    $('statTotal').textContent = s.total;
    $('statUncat').textContent = s.uncategorizedCount;
    $('statCats').textContent = s.categories.length;
    $('statPending').textContent = s.pendingAi;
    if ($('statHistory')) $('statHistory').textContent = s.historyTotal || 0;
    const list = $('catList');
    if (s.categories.length === 0) {
      list.innerHTML = '<div class="muted small">暂无分类。打开选项页创建吧。</div>';
    } else {
      list.innerHTML = '';
      for (const c of s.categories) {
        const row = document.createElement('div');
        row.className = 'catRow';
        row.innerHTML = '<span class="dot" style="background:' + c.color + '"></span>' +
                        '<span class="name"></span>' +
                        '<span class="count"></span>';
        row.querySelector('.name').textContent = c.name;
        row.querySelector('.count').textContent = c.count;
        list.appendChild(row);
      }
    }
    await refreshSync();
  }

  function renderSync(s) {
    const active = ['starting', 'running', 'stopping'].includes(s.state);
    $('fullSync').disabled = active;
    $('stopSync').classList.toggle('hidden', !active);
    const progress = $('syncProgress');
    progress.classList.toggle('error', s.state === 'error');
    if (s.state === 'starting') progress.textContent = '正在连接 X 登录会话…';
    else if (s.state === 'running') progress.textContent = '同步中：' + s.pages + ' 页 / ' + s.fetched + ' 条；新增 ' + s.added + '，更新 ' + s.updated;
    else if (s.state === 'stopping') progress.textContent = '正在停止，等待当前分页完成…';
    else if (s.state === 'completed') {
      progress.textContent = '同步完成：' + s.pages + ' 页 / ' + s.fetched + ' 条；新增 ' + s.added + '，更新 ' + s.updated +
        (s.warning ? '。提示：' + s.warning : '');
    }
    else if (s.state === 'stopped') progress.textContent = '已停止：已同步 ' + s.fetched + ' 条' + (s.warning ? '。提示：' + s.warning : '');
    else if (s.state === 'error') progress.textContent = '同步失败：' + (s.error || '未知错误');
    else progress.textContent = '打开已登录的 x.com 后开始，不需要输入密码。';

    if (lastSyncState && lastSyncState !== s.state && ['completed', 'stopped'].includes(s.state)) refreshStatsOnly();
    lastSyncState = s.state;
  }

  async function refreshStatsOnly() {
    const r = await send('xb/stats');
    if (!r.ok) return;
    const s = r.data;
    $('statTotal').textContent = s.total;
    $('statUncat').textContent = s.uncategorizedCount;
    $('statCats').textContent = s.categories.length;
    $('statPending').textContent = s.pendingAi;
    if ($('statHistory')) $('statHistory').textContent = s.historyTotal || 0;
  }

  async function refreshSync() {
    const r = await send('xb/sync/status');
    if (r.ok) renderSync(r.data);
  }

  function bind() {
    $('openOptions').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
    $('openHistory').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#history') });
    });
    $('scanNow').addEventListener('click', async () => {
      const btn = $('scanNow');
      btn.disabled = true; btn.textContent = '抓取中…';
      const r = await send('xb/content/scan');
      btn.disabled = false; btn.textContent = '扫描当前可见页';
      if (r.ok) {
        if (r.data && r.data.skipped) toast(r.data.reason || '已跳过');
        else {
          const d = r.data || {};
          if (!d.found) toast('页面暂未发现书签，请等待列表加载后重试');
          else toast('抓取完成：发现 ' + d.found + '，新增 ' + (d.added || 0) + '，更新 ' + (d.updated || 0));
          await refresh();
        }
      } else {
        toast(r.error, true);
      }
    });
    $('fullSync').addEventListener('click', async () => {
      const btn = $('fullSync');
      btn.disabled = true;
      const r = await send('xb/sync/start');
      if (!r.ok) toast(r.error, true);
      await refreshSync();
    });
    $('stopSync').addEventListener('click', async () => {
      $('stopSync').disabled = true;
      const r = await send('xb/sync/stop');
      $('stopSync').disabled = false;
      if (!r.ok) toast(r.error, true);
      await refreshSync();
    });
    $('aiRun').addEventListener('click', async () => {
      const btn = $('aiRun');
      btn.disabled = true; btn.textContent = 'AI 思考中…';
      const r = await send('xb/ai/run', { limit: 50 });
      btn.disabled = false; btn.textContent = '✨ AI 整理未分类';
      if (r.ok) {
        if (!r.data || r.data.count === 0) toast('没有未分类的书签');
        else { chrome.runtime.openOptionsPage(); toast('AI 已生成 ' + r.data.count + ' 条建议，去选项页确认'); }
      } else {
        toast(r.error, true);
      }
    });
    $('manualAdd').addEventListener('click', async () => {
      const url = $('manualUrl').value.trim();
      if (!url) return;
      const btn = $('manualAdd');
      btn.disabled = true; btn.textContent = '添加中…';
      const r = await send('xb/bookmarks/manualAdd', { url });
      btn.disabled = false; btn.textContent = '添加';
      if (r.ok) {
        $('manualUrl').value = '';
        toast('已添加：' + ((r.data.item.author && r.data.item.author.handle) || r.data.item.id));
        refresh();
      } else {
        toast(r.error, true);
      }
    });
  }

  bind();
  refresh();
  setInterval(refreshSync, 1200);
})();
