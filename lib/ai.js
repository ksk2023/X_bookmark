// AI 客户端：调用 OpenAI 兼容的 chat completions 接口。
// API key / baseUrl / model 由用户在 options 页面配置，存于 chrome.storage.local。
// 这个模块本身不持有状态，每次调用都传 config 进来。

(function (root) {
  'use strict';

  const Util = root.XBUtil;

  const SYSTEM_PROMPT = [
    '你是一个专业的 X (Twitter) 书签分类助手。你的目标是把每一条书签都分到一个最合适的分类，让用户能快速找到内容。',
    '分类规则：',
    '1. 每条书签必须分到一个分类。尽量根据正文主题、作者领域、关键词给出判断，而不是返回 null。',
    '2. 只有正文完全无意义、乱码或无任何可判断信息时，才允许 categoryId 返回 null。',
    '3. 优先复用已有分类：已有分类的 id 必须原样填到 categoryId 字段，判断时综合考虑分类名称和 description。',
    '4. 当已有分类确实都不合适时，主动提议新分类：categoryId 填 null，categoryName 填一个简短、通用的主题名（2-6 个汉字或 1-3 个英文单词），例如「人工智能」「加密货币」「前端开发」「投资理财」等。',
    '5. 同类内容要尽量归到同一个分类，避免为主题相近的内容反复新建分类。',
    '6. reason 用一句话中文说明判断依据（主题/领域/关键词），<= 30 字。',
    '7. **只输出严格 JSON 数组**，不要任何解释、Markdown 代码块或前后缀。',
    '8. 数组长度、顺序必须与输入完全一致，每个元素形如 {id, categoryId, categoryName, reason}。',
  ].join('\n');

  function buildUserPrompt(bookmarks, categories) {
    const cats = categories.map((c) => ({ id: c.id, name: c.name, description: c.description || '' }));
    const items = bookmarks.map((b) => ({
      id: b.id,
      author: b.author ? `${b.author.name || ''} (@${b.author.handle || ''})`.trim() : '',
      text: Util.plainText(b.text).slice(0, 600),
    }));
    return JSON.stringify({ categories: cats, items });
  }

  function parseAiResponse(rawText, expectedIds) {
    let txt = String(rawText || '').trim();
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let arr;
    try {
      arr = JSON.parse(txt);
    } catch (e) {
      const m = txt.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('AI 返回的不是 JSON：' + txt.slice(0, 200));
      arr = JSON.parse(m[0]);
    }
    if (!Array.isArray(arr)) throw new Error('AI 返回的不是数组');
    const map = new Map();
    for (const it of arr) {
      if (it && it.id) map.set(String(it.id), it);
    }
    return expectedIds.map((id) => {
      const it = map.get(String(id));
      if (!it) return { tweetId: id, categoryId: null, categoryName: null, reason: 'AI 未返回' };
      return {
        tweetId: id,
        categoryId: it.categoryId || null,
        categoryName: it.categoryName || null,
        reason: String(it.reason || '').slice(0, 60),
      };
    });
  }

  function chatCompletionUrl(baseUrl) {
    const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(base) ? base : (base + '/chat/completions');
  }

  function normalizeContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (typeof part.value === 'string') return part.value;
        return '';
      }).join('');
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.value === 'string') return content.value;
    }
    return '';
  }

  function extractChatContent(data) {
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    const direct = normalizeContent(msg && msg.content).trim();
    if (direct) return direct;
    const text = normalizeContent(choice && choice.text).trim();
    if (text) return text;
    const outputText = normalizeContent(data && data.output_text).trim();
    if (outputText) return outputText;
    return '';
  }

  async function callChat(config, { system, user, temperature = 0.2, maxTokens = 1500, timeoutMs = 60000 } = {}) {
    if (!config || !config.apiKey) throw new Error('尚未配置 API Key');
    const url = chatCompletionUrl(config.baseUrl);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.apiKey,
        },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}：${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = extractChatContent(data);
    if (!content) {
      const choice = data && data.choices && data.choices[0];
      const msg = choice && choice.message;
      const keys = msg && typeof msg === 'object' ? Object.keys(msg).join(',') : '';
      const reason = choice && choice.finish_reason ? ('finish_reason=' + choice.finish_reason) : '';
      throw new Error('AI 返回为空' + (reason || keys ? '（' + [reason, keys ? ('message字段：' + keys) : ''].filter(Boolean).join('；') + '）' : ''));
    }
    return content;
  }

  // 把一批未分类书签交给 AI，返回对齐后的建议列表。
  function composeSystemPrompt(customPrompt) {
    const extra = String(customPrompt || '').trim();
    const sep = "\n\n用户的额外分类要求（请严格遵守）：\n";
    return extra ? (SYSTEM_PROMPT + sep + extra) : SYSTEM_PROMPT;
  }

  async function suggestCategories(config, bookmarks, categories, { batchSize = 20, customPrompt } = {}) {
    if (!bookmarks || bookmarks.length === 0) return [];
    const system = composeSystemPrompt(customPrompt != null ? customPrompt : (config && config.customPrompt));
    const out = [];
    for (let i = 0; i < bookmarks.length; i += batchSize) {
      const slice = bookmarks.slice(i, i + batchSize);
      const ids = slice.map((b) => b.id);
      const user = buildUserPrompt(slice, categories);
      const raw = await callChat(config, {
        system: system,
        user,
        temperature: 0.2,
        maxTokens: Math.min(4000, 200 + slice.length * 150),
      });
      const parsed = parseAiResponse(raw, ids);
      out.push(...parsed);
    }
    return out;
  }

  async function ping(config) {
    if (!config || !config.apiKey) throw new Error('尚未配置 API Key');
    const content = await callChat(config, {
      system: '你是一个连通性测试助手。',
      user: '不要推理，不要解释，请只回复一个字：好',
      temperature: 0,
      maxTokens: 256,
      timeoutMs: 20000,
    });
    return String(content).trim();
  }

  const api = { suggestCategories, ping, _parseAiResponse: parseAiResponse, _buildUserPrompt: buildUserPrompt };
  root.XBAI = api;
})(typeof self !== 'undefined' ? self : globalThis);
