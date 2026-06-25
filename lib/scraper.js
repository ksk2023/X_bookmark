// X 书签页 DOM 抓取。
// X 的 DOM 经常调整，所以这里只挑稳健的字段（data-testid、time[a]、tweetText），
// 拿不到就跳过这条推文，绝不抛错。

(function (root) {
  'use strict';

  const Util = root.XBUtil;

  // 抓单条 article。如果不是书签项，返回 null。
  function parseArticle(article) {
    if (!article || article.nodeType !== 1) return null;

    // 1) 推文 ID / URL：优先取发布时间所在链接，避免误拿引用推文的 status。
    const timeEl = article.querySelector('time');
    let statusLink = timeEl && timeEl.closest ? timeEl.closest('a[href*="/status/"]') : null;
    if (!statusLink) {
      statusLink = Array.from(article.querySelectorAll('a[href*="/status/"]'))
        .find((a) => /\/status\/\d+/.test(a.getAttribute('href') || a.href || '')) || null;
    }
    if (!statusLink) return null;
    const rawUrl = statusLink.href || statusLink.getAttribute('href') || '';
    const m = rawUrl.match(/\/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];
    const url = statusLink.href || ('https://x.com' + rawUrl);

    // 2) 作者：User-Name 区块里第一个 link 文本是显示名，href 末尾是 handle
    const userNameBox = article.querySelector('[data-testid="User-Name"]');
    let name = '';
    let handle = '';
    if (userNameBox) {
      const displayEl = userNameBox.querySelector('a[role="link"] span');
      if (displayEl) name = displayEl.textContent.trim();
      const handleLink = Array.from(userNameBox.querySelectorAll('a[href^="/"]'))
        .find((a) => /^\/[^/?#]+\/?$/.test(a.getAttribute('href') || ''));
      if (handleLink) {
        const segs = handleLink.getAttribute('href').split('/').filter(Boolean);
        if (segs.length) handle = segs[0];
      }
    }

    // 3) 正文
    let text = '';
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (textEl) text = textEl.innerText.trim();

    // 4) 推文时间
    let tweetTime = null;
    if (timeEl) {
      tweetTime = timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || null;
    }

    // 5) 媒体（图片、视频、链接卡片）
    const media = [];
    article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
      if (img.src) media.push({ type: 'photo', url: img.src });
    });
    article.querySelectorAll('video').forEach((v) => {
      const src = v.src || v.querySelector('source')?.src;
      const poster = v.poster;
      if (src) media.push({ type: 'video', url: src, poster: poster || null });
      else if (poster) media.push({ type: 'video', url: poster, poster });
    });
    article.querySelectorAll('[data-testid="card.wrapper"]').forEach((c) => {
      const link = c.querySelector('a[href]');
      if (link && link.href) media.push({ type: 'link', url: link.href });
    });

    // 6) 头像
    let avatar = '';
    const av = article.querySelector('[data-testid="Tweet-User-Avatar"] img, img[src*="profile_images"]');
    if (av) avatar = av.src;

    return {
      id,
      url,
      author: { name, handle, avatar },
      text,
      tweetTime,
      media,
    };
  }

  // 在容器内找到所有书签 article。
  function findBookmarkArticles(root) {
    if (!root || !root.querySelectorAll) return [];
    // 书签页的主体 article 用 data-testid="tweet"。其它 tab（推文/回复）也是同一个 testid，
    // 我们靠父级选择器 + URL 路径（已通过 manifest 限定到 /i/bookmarks）来约束。
    return Array.from(root.querySelectorAll('[data-testid="tweet"]'));
  }

  // 在主区域里扫描一次，返回本次新增的 tweetIds。
  function scanOnce() {
    const articles = findBookmarkArticles(document);
    const out = [];
    const seen = new Set();
    for (const a of articles) {
      const t = parseArticle(a);
      if (!t || !t.id) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }

  // 简单的滚动触发：把页面滚到底，触发 X 加载更多书签。
  // 间隔与次数都是保守值——抓取以观察者为主，scroll 只是补全。
  async function autoScroll({ step = 1200, pauseMs = 800, maxSteps = 20 } = {}) {
    let lastHeight = document.documentElement.scrollHeight;
    let stagnant = 0;
    for (let i = 0; i < maxSteps; i++) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, pauseMs));
      const nextHeight = document.documentElement.scrollHeight;
      stagnant = nextHeight <= lastHeight ? stagnant + 1 : 0;
      lastHeight = nextHeight;
      if (stagnant >= 2) break;
    }
    // 滚回顶部
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  const api = { parseArticle, findBookmarkArticles, scanOnce, autoScroll };
  root.XBScraper = api;
})(typeof self !== 'undefined' ? self : globalThis);
