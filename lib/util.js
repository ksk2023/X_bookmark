// 工具函数。在 content script / background / options / popup 之间复用。
// 通过 <script> 顺序加载，挂到 self（globalThis）上，避免 ESM 在 content script 中的限制。

(function (root) {
  'use strict';

  const Util = {
    uid() {
      // 14 字节随机，base36 紧凑写法
      const arr = new Uint8Array(10);
      (self.crypto || root.crypto).getRandomValues(arr);
      return Array.from(arr, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
    },

    now() {
      return Date.now();
    },

    escapeHtml(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    fmtDate(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    fmtRel(ms) {
      if (!ms) return '';
      const diff = Date.now() - ms;
      const s = Math.floor(diff / 1000);
      if (s < 60) return '刚刚';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m} 分钟前`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h} 小时前`;
      const day = Math.floor(h / 24);
      if (day < 30) return `${day} 天前`;
      return this.fmtDate(ms);
    },

    // 从推文里抽纯文本（去除链接/换行），用于 AI 输入和搜索
    plainText(t) {
      if (!t) return '';
      return String(t).replace(/\s+/g, ' ').trim();
    },

    debounce(fn, wait) {
      let t = null;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    // 简单 hash 用于同推文去重（避免 X 反复插入同样的 DOM）
    hashKey(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    },
  };

  root.XBUtil = Util;
})(typeof self !== 'undefined' ? self : globalThis);
