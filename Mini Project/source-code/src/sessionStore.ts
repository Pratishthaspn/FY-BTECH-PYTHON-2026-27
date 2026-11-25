import fs from 'fs';
import path from 'path';
import session from 'express-session';

interface StoredSession {
  data: session.SessionData;
  expiresAt: number | null;
}

function resolveSessionFilePath(): string {
  if (process.env.VERCEL) {
    return path.join('/tmp', 'crm-sessions.json');
  }
  const candidates = [
    path.join(process.cwd(), '.data', 'sessions.json'),
    path.join('/tmp', 'crm-sessions.json')
  ];
  for (const filePath of candidates) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return filePath;
    } catch {
      // try next candidate
    }
  }
  return path.join('/tmp', 'crm-sessions.json');
}

export class FileSessionStore extends session.Store {
  private filePath: string;
  private sessions = new Map<string, StoredSession>();

  constructor() {
    super();
    this.filePath = resolveSessionFilePath();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, StoredSession>;
      const now = Date.now();
      for (const [sid, entry] of Object.entries(parsed)) {
        if (entry && (!entry.expiresAt || entry.expiresAt > now)) {
          this.sessions.set(sid, entry);
        }
      }
    } catch {
      this.sessions.clear();
    }
  }

  private saveToDisk(): void {
    try {
      const now = Date.now();
      const obj: Record<string, StoredSession> = {};
      for (const [sid, entry] of this.sessions.entries()) {
        if (!entry.expiresAt || entry.expiresAt > now) {
          obj[sid] = entry;
        } else {
          this.sessions.delete(sid);
        }
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(obj), 'utf8');
    } catch {
      // ignore write errors in read-only environments
    }
  }

  private computeExpiry(sess: session.SessionData): number | null {
    if (sess.cookie && sess.cookie.expires) {
      return new Date(sess.cookie.expires).getTime();
    }
    if (sess.cookie && typeof sess.cookie.maxAge === 'number') {
      return Date.now() + sess.cookie.maxAge;
    }
    return Date.now() + 7 * 24 * 60 * 60 * 1000;
  }

  override get(
    sid: string,
    callback: (err?: unknown, session?: session.SessionData | null) => void
  ): void {
    const entry = this.sessions.get(sid);
    if (!entry) {
      return callback(null, null);
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.sessions.delete(sid);
      this.saveToDisk();
      return callback(null, null);
    }
    return callback(null, entry.data);
  }

  override set(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: unknown) => void
  ): void {
    this.sessions.set(sid, {
      data: sess,
      expiresAt: this.computeExpiry(sess)
    });
    this.saveToDisk();
    callback?.();
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.sessions.delete(sid);
    this.saveToDisk();
    callback?.();
  }

  override touch(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: unknown) => void
  ): void {
    const entry = this.sessions.get(sid);
    if (entry) {
      entry.data = sess;
      entry.expiresAt = this.computeExpiry(sess);
      this.saveToDisk();
    }
    callback?.();
  }
}
