'use strict';

const fs = require('node:fs');

// This index contains explicitly saved thread names. Rollout messages are never
// a fallback: their first user message is not necessarily a conversation title.
class CodexTitleIndex {
  constructor(options = {}) {
    this.file = options.file;
    this.checkIntervalMs = options.checkIntervalMs ?? 5000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 10000;
    this.titles = new Map();
    this.lastCheck = -Infinity;
    this.signature = null;
  }

  refresh(now = Date.now()) {
    if (now >= this.lastCheck && now - this.lastCheck < this.checkIntervalMs) return;
    this.lastCheck = now;
    let fd;
    try {
      const stat = fs.statSync(this.file);
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (signature === this.signature) return;
      const start = Math.max(0, stat.size - this.maxBytes);
      const buffer = Buffer.alloc(Math.min(stat.size, this.maxBytes));
      fd = fs.openSync(this.file, 'r');
      let bytes = 0;
      while (bytes < buffer.length) {
        const amount = fs.readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
        if (!amount) break;
        bytes += amount;
      }
      let offset = 0;
      if (start > 0) {
        const preceding = Buffer.alloc(1);
        fs.readSync(fd, preceding, 0, 1, start - 1);
        if (preceding[0] !== 10) {
          const newline = buffer.indexOf(10);
          offset = newline < 0 ? bytes : newline + 1;
        }
      }
      const titles = new Map();
      for (const line of buffer.toString('utf8', offset, bytes).replace(/^\uFEFF/, '').split('\n')) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row.id !== 'string' || typeof row.thread_name !== 'string') continue;
        if (!row.id || row.id.length > 256) continue;
        const parsedTime = Date.parse(row.updated_at);
        const updatedAt = Number.isFinite(parsedTime) ? parsedTime : 0;
        const previous = titles.get(row.id);
        if (previous && previous.updatedAt > updatedAt) continue;
        titles.delete(row.id);
        titles.set(row.id, { title: row.thread_name.trim() ? row.thread_name.slice(0, 512) : null, updatedAt });
        if (titles.size > this.maxEntries) titles.delete(titles.keys().next().value);
      }
      this.titles = titles;
      this.signature = signature;
    } catch {
      // A removed/unreadable index must not keep a renamed or deleted title live.
      this.titles.clear();
      this.signature = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  get(sessionId) { return this.titles.get(sessionId)?.title || null; }
}

module.exports = { CodexTitleIndex };
