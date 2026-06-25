// X 登录态书签分页客户端。
// 在 x.com 内容脚本中运行，复用当前浏览器会话；不读取、不保存 auth_token 或密码。

(function (root) {
  'use strict';

  // X rotates this hash periodically; discoveredQueryId caches whatever we
  // scrape from X's own JS bundle so the sync keeps working after a rollout.
  let QUERY_ID = 'xLjCVTqYWz8CGSprLU349w';
  let discoveredQueryId = '';
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const FEATURES = {
    graphql_timeline_v2_bookmark_timeline: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  function cookie(name) {
    const prefix = name + '=';
    const part = String(root.document && root.document.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(prefix));
    return part ? decodeURIComponent(part.slice(prefix.length)) : '';
  }

  // Scrape the current Bookmarks queryId from X's own main JS bundle so we
  // survive X rotating the operation hash. Looks for the operation definition.
  async function discoverQueryId() {
    if (discoveredQueryId) return discoveredQueryId;
    try {
      // Scan all loaded X JS bundles; the Bookmarks operation can live in main, vendor, or an on-demand chunk.
      const scriptUrls = Array.from(document.scripts || [])
        .map((s) => s.src || '')
        .filter((u) => /x\.com|twimg\.com/.test(u) && /\.js(\?|$)/.test(u));
      const tryFromText = (txt) => {
        // X encodes operations as {queryId:"...",operationName:"Bookmarks",operationType:"query"}
        const m = txt.match(/\{[^{}]*queryId:"([^"]+)"[^{}]*operationName:"Bookmarks"[^{}]*\}/);
        if (m) return m[1];
        // Fallback: some builds inline operationName before queryId.
        const m2 = txt.match(/\{[^{}]*operationName:"Bookmarks"[^{}]*queryId:"([^"]+)"[^{}]*\}/);
        return m2 ? m2[1] : null;
      };
      for (const u of scriptUrls) {
        try {
          const res = await root.fetch(u, { credentials: 'include' });
          if (!res.ok) continue;
          const txt = await res.text();
          const id = tryFromText(txt);
          if (id) { discoveredQueryId = id; return id; }
        } catch (e) { /* ignore one bundle failure */ }
      }
    } catch (e) { /* discovery best-effort */ }
    return null;
  }

  function buildUrl(cursor) {
    const variables = { count: 100, includePromotedContent: false };
    if (cursor) variables.cursor = cursor;
    return 'https://x.com/i/api/graphql/' + QUERY_ID + '/Bookmarks' +
      '?variables=' + encodeURIComponent(JSON.stringify(variables)) +
      '&features=' + encodeURIComponent(JSON.stringify(FEATURES));
  }

  function unwrapTweet(value) {
    if (value && value.__typename === 'TweetWithVisibilityResults' && value.tweet) return value.tweet;
    return value;
  }

  function tweetFromItem(itemContent) {
    return unwrapTweet(itemContent && itemContent.tweet_results && itemContent.tweet_results.result);
  }

  function parsePage(data) {
    const instructions = data && data.data && data.data.bookmark_timeline_v2 &&
      data.data.bookmark_timeline_v2.timeline && data.data.bookmark_timeline_v2.timeline.instructions || [];
    const tweets = [];
    let nextCursor = null;

    for (const instruction of instructions) {
      const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
      for (const entry of entries) {
        const content = entry && entry.content;
        if (!content) continue;
        if (content.entryType === 'TimelineTimelineCursor' && content.cursorType === 'Bottom') {
          nextCursor = content.value || null;
          continue;
        }
        if (content.entryType === 'TimelineTimelineItem') {
          const tweet = tweetFromItem(content.itemContent);
          if (tweet && tweet.rest_id) tweets.push(tweet);
          continue;
        }
        if (content.entryType === 'TimelineTimelineModule') {
          for (const moduleItem of content.items || []) {
            const tweet = tweetFromItem(moduleItem && moduleItem.item && moduleItem.item.itemContent);
            if (tweet && tweet.rest_id) tweets.push(tweet);
          }
        }
      }
    }
    return { tweets, nextCursor };
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  }

  function fullText(tweet) {
    const note = tweet && tweet.note_tweet && tweet.note_tweet.note_tweet_results &&
      tweet.note_tweet.note_tweet_results.result;
    if (note && note.text) return decodeHtml(note.text);
    const article = tweet && tweet.article && tweet.article.article_results && tweet.article.article_results.result;
    if (article) {
      const parts = [];
      if (article.title) parts.push(article.title);
      if (article.content) parts.push(article.content);
      if (!parts.length && article.content_state && Array.isArray(article.content_state.blocks)) {
        const blockText = article.content_state.blocks
          .map((b) => String(b && b.text || '').trim())
          .filter(Boolean)
          .join('\n\n');
        if (blockText) parts.push(blockText);
      }
      if (parts.length) return decodeHtml(parts.join('\n\n'));
    }
    return decodeHtml(tweet && tweet.legacy && tweet.legacy.full_text || '');
  }

  function bestVideo(variants) {
    return (variants || [])
      .filter((v) => v && v.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
  }

  function mediaOf(tweet) {
    const legacy = tweet && tweet.legacy || {};
    const entities = legacy.extended_entities && legacy.extended_entities.media ||
      legacy.entities && legacy.entities.media || [];
    const media = [];
    for (const item of entities) {
      const thumb = item && item.media_url_https || '';
      if (item && (item.type === 'video' || item.type === 'animated_gif')) {
        const video = bestVideo(item.video_info && item.video_info.variants);
        if (video && video.url) media.push({ type: item.type === 'animated_gif' ? 'gif' : 'video', url: video.url, poster: thumb || null });
        else if (thumb) media.push({ type: 'video', url: thumb, poster: thumb });
      } else if (thumb) {
        media.push({ type: 'photo', url: thumb });
      }
    }
    if (!media.length) {
      const article = tweet && tweet.article && tweet.article.article_results && tweet.article.article_results.result;
      const cover = article && ((article.cover_media && article.cover_media.media_info && article.cover_media.media_info.original_img_url) ||
        (article.preview_image && article.preview_image.url));
      if (cover) media.push({ type: 'photo', url: cover });
    }
    return media;
  }

  function normalizeTweet(tweet) {
    tweet = unwrapTweet(tweet);
    if (!tweet || !tweet.rest_id) return null;
    const userResult = tweet.core && tweet.core.user_results && tweet.core.user_results.result || {};
    const user = userResult.legacy || {};
    const handle = user.screen_name || '';
    const author = {
      name: user.name || '',
      handle,
      avatar: user.profile_image_url_https || '',
      followers: Number(user.followers_count) || 0,
      following: Number(user.friends_count) || 0,
      statuses: Number(user.statuses_count) || 0,
      mediaCount: Number(user.media_count) || 0,
      verified: !!(userResult.is_blue_verified || (tweet.core && tweet.core.user_results && tweet.core.user_results.result && tweet.core.user_results.result.is_blue_verified)),
      description: user.description || '',
      profileBanner: user.profile_banner_url || '',
    };
    return {
      id: String(tweet.rest_id),
      url: 'https://x.com/' + (handle || 'i') + '/status/' + tweet.rest_id,
      author,
      text: fullText(tweet),
      tweetTime: tweet.legacy && tweet.legacy.created_at || null,
      media: mediaOf(tweet),
      language: tweet.legacy && tweet.legacy.lang || null,
      source: 'x-graphql',
    };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchPage(cursor, attempt) {
    const ct0 = cookie('ct0');
    if (!ct0) throw new Error('未找到 X 登录会话，请登录 x.com 后刷新页面');
    const response = await root.fetch(buildUrl(cursor), {
      method: 'GET',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer ' + BEARER,
        'X-Csrf-Token': ct0,
        'X-Twitter-Auth-Type': 'OAuth2Session',
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Client-Language': 'zh-cn',
        Accept: '*/*',
      },
    });

    if ((response.status === 429 || response.status >= 500) && (attempt || 0) < 3) {
      const retryAfter = Number(response.headers.get('retry-after')) || 0;
      await wait(Math.min(30000, Math.max(1500 * Math.pow(2, attempt || 0), retryAfter * 1000)));
      return fetchPage(cursor, (attempt || 0) + 1);
    }
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) throw new Error('X 登录会话无效或已过期，请重新登录并刷新页面');
      if (response.status === 400 || response.status === 404) {
        // Most common cause of 400/404 + later 'X 接口错误' is a rotated queryId.
        if (!cursor && (attempt || 0) < 1) {
          const fresh = await discoverQueryId();
          if (fresh && fresh !== QUERY_ID) { QUERY_ID = fresh; return fetchPage(cursor, 1); }
        }
        throw new Error('X 内部书签接口已更新（HTTP ' + response.status + '），插件已尝试自动获取新接口；若仍失败，刷新 x.com 后再试一次。');
      }
      throw new Error('X 书签接口返回 HTTP ' + response.status + '：' + body.slice(0, 160));
    }
    const data = await response.json();
    if (Array.isArray(data.errors) && data.errors.length) {
      // A JSON error body often means the queryId is stale; try to refresh once.
      if (!cursor && (attempt || 0) < 1) {
        const fresh = await discoverQueryId();
        if (fresh && fresh !== QUERY_ID) { QUERY_ID = fresh; return fetchPage(cursor, (attempt || 0) + 1); }
      }
      const msg = String(data.errors[0].message || '未知错误');
      throw new Error('X 接口错误：' + msg + '（这通常是 X 更新了内部接口，插件已尝试自动获取新接口；刷新 x.com 页面后再同步通常能恢复）');
    }
    return data;
  }

  async function syncAll(options) {
    options = options || {};
    const onPage = options.onPage || (async () => {});
    const shouldStop = options.shouldStop || (() => false);
    // Best-effort: refresh the queryId from X's bundle before paging, so a rotated
    // hash doesn't surface as a hard error on the first request.
    { const fresh = await discoverQueryId(); if (fresh && fresh !== QUERY_ID) QUERY_ID = fresh; }
    const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 500, 1000));
    const pauseMs = Math.max(250, Number(options.pauseMs) || 700);
    const seenCursors = new Set();
    let cursor = null;
    let page = 0;
    let fetched = 0;

    while (page < maxPages && !shouldStop()) {
      const data = await fetchPage(cursor, 0);
      const parsed = parsePage(data);
      const items = [];
      const ids = new Set();
      for (const tweet of parsed.tweets) {
        const item = normalizeTweet(tweet);
        if (item && !ids.has(item.id)) {
          ids.add(item.id);
          items.push(item);
        }
      }
      page++;
      fetched += items.length;
      await onPage({ page, fetched, items, nextCursor: parsed.nextCursor, hasMore: !!parsed.nextCursor });

      if (!parsed.nextCursor) return { stopped: false, complete: true, limited: false, page, fetched };
      if (seenCursors.has(parsed.nextCursor)) {
        return {
          stopped: false,
          complete: false,
          limited: true,
          reason: 'duplicate-cursor',
          warning: 'X 返回了重复分页游标；已保存当前同步结果，没有继续请求以避免循环。',
          page,
          fetched,
        };
      }
      seenCursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
      if (!shouldStop()) await wait(pauseMs);
    }
    return { stopped: shouldStop(), complete: false, limited: false, page, fetched };
  }

  root.XBXApi = {
    syncAll,
    _buildUrl: buildUrl,
    _parsePage: parsePage,
    _normalizeTweet: normalizeTweet,
  };
})(typeof self !== 'undefined' ? self : globalThis);
