// Durable, atomic JSON state (the Telegram update offset lives here).

import fs from 'node:fs';
import path from 'node:path';

export class JsonState {
  constructor(file, defaults = {}, logger = null) {
    this.file = file;
    this.logger = logger;
    this.data = { ...defaults };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = { ...this.data, ...parsed };
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      try {
        const bad = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, bad);
        this.logger?.warn('state file corrupt - moved aside', { file: bad });
      } catch {
        this.logger?.warn('state file unreadable - starting fresh');
      }
    }
  }

  get(key, fallback = null) {
    return this.data[key] ?? fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.schedule();
    return value;
  }

  update(patch) {
    Object.assign(this.data, patch || {});
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        fs.rmSync(this.file, { force: true });
        fs.renameSync(tmp, this.file);
      }
    } catch (error) {
      this.logger?.warn('state save failed', { error: error?.message || String(error) });
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  close() {
    this.flush();
  }
}
