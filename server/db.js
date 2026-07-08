import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', 'data.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL DEFAULT 'public' CHECK (type IN ('public', 'dm')),
    topic       TEXT NOT NULL DEFAULT '',
    created_by  INTEGER REFERENCES users(id),
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    parent_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, parent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

  CREATE TABLE IF NOT EXISTS reactions (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
`);

const AVATAR_COLORS = [
  '#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e',
  '#7c3085', '#e8912d', '#3f6ea6', '#d6409f',
];

function now() {
  return Date.now();
}

// ---------- users ----------

export function createUser(username, displayName, passwordHash) {
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, avatar_color, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(username, displayName, passwordHash, color, now());
  return getUserById(Number(result.lastInsertRowid));
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers() {
  return db
    .prepare('SELECT id, username, display_name, avatar_color FROM users ORDER BY display_name')
    .all();
}

export function publicUser(user) {
  if (!user) return null;
  const { id, username, display_name, avatar_color } = user;
  return { id, username, display_name, avatar_color };
}

// ---------- channels ----------

export function createChannel(name, createdBy, topic = '') {
  const result = db
    .prepare(
      `INSERT INTO channels (name, type, topic, created_by, created_at)
       VALUES (?, 'public', ?, ?, ?)`
    )
    .run(name, topic, createdBy ?? null, now());
  const channelId = Number(result.lastInsertRowid);
  if (createdBy) addMember(channelId, createdBy);
  return getChannelById(channelId);
}

export function getChannelById(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

export function getChannelByName(name) {
  return db.prepare('SELECT * FROM channels WHERE name = ?').get(name);
}

export function listPublicChannels() {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) AS member_count
       FROM channels c WHERE c.type = 'public' ORDER BY c.name`
    )
    .all();
}

export function listDmChannels(userId) {
  // DM channels the user belongs to, plus the "other" participant.
  return db
    .prepare(
      `SELECT c.id, c.name, c.type,
              u.id AS peer_id, u.username AS peer_username,
              u.display_name AS peer_display_name, u.avatar_color AS peer_avatar_color
       FROM channels c
       JOIN channel_members me ON me.channel_id = c.id AND me.user_id = ?
       JOIN channel_members other ON other.channel_id = c.id AND other.user_id != ?
       JOIN users u ON u.id = other.user_id
       WHERE c.type = 'dm'
       ORDER BY u.display_name`
    )
    .all(userId, userId);
}

export function addMember(channelId, userId) {
  db.prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read) VALUES (?, ?, ?)`
  ).run(channelId, userId, now());
}

export function countMembers(channelId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?')
    .get(channelId).n;
}

export function isMember(channelId, userId) {
  return !!db
    .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId);
}

export function listMemberChannelIds(userId) {
  return db
    .prepare('SELECT channel_id FROM channel_members WHERE user_id = ?')
    .all(userId)
    .map((r) => r.channel_id);
}

export function getOrCreateDm(userA, userB) {
  const [lo, hi] = userA < userB ? [userA, userB] : [userB, userA];
  const name = `dm:${lo}:${hi}`;
  let channel = getChannelByName(name);
  let created = false;
  if (!channel) {
    const result = db
      .prepare(
        `INSERT INTO channels (name, type, topic, created_by, created_at)
         VALUES (?, 'dm', '', ?, ?)`
      )
      .run(name, userA, now());
    const channelId = Number(result.lastInsertRowid);
    addMember(channelId, lo);
    addMember(channelId, hi);
    channel = getChannelById(channelId);
    created = true;
  }
  return { channel, created };
}

export function markRead(channelId, userId) {
  db.prepare(
    'UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?'
  ).run(now(), channelId, userId);
}

export function unreadCounts(userId) {
  const rows = db
    .prepare(
      `SELECT cm.channel_id, COUNT(m.id) AS unread
       FROM channel_members cm
       LEFT JOIN messages m
         ON m.channel_id = cm.channel_id
        AND m.created_at > cm.last_read
        AND m.user_id != cm.user_id
       WHERE cm.user_id = ?
       GROUP BY cm.channel_id`
    )
    .all(userId);
  const map = {};
  for (const r of rows) map[r.channel_id] = r.unread;
  return map;
}

// ---------- messages ----------

function attachReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = messages.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${placeholders})`
    )
    .all(...ids);
  const byMessage = new Map();
  for (const r of rows) {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, new Map());
    const byEmoji = byMessage.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  for (const m of messages) {
    const byEmoji = byMessage.get(m.id);
    m.reactions = byEmoji
      ? [...byEmoji.entries()].map(([emoji, users]) => ({ emoji, count: users.length, users }))
      : [];
  }
  return messages;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.user_id, m.parent_id, m.content, m.created_at, m.updated_at,
         u.username, u.display_name, u.avatar_color,
         (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id) AS reply_count
  FROM messages m JOIN users u ON u.id = m.user_id`;

export function createMessage(channelId, userId, content, parentId = null) {
  const result = db
    .prepare(
      `INSERT INTO messages (channel_id, user_id, parent_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(channelId, userId, parentId, content, now());
  return getMessageById(Number(result.lastInsertRowid));
}

export function getMessageById(id) {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  if (!row) return null;
  return attachReactions([row])[0];
}

export function getChannelMessages(channelId, limit = 200) {
  const rows = db
    .prepare(
      `${MESSAGE_SELECT}
       WHERE m.channel_id = ? AND m.parent_id IS NULL
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
    )
    .all(channelId, limit)
    .reverse();
  return attachReactions(rows);
}

export function getThreadMessages(parentId) {
  const rows = db
    .prepare(`${MESSAGE_SELECT} WHERE m.parent_id = ? ORDER BY m.created_at, m.id`)
    .all(parentId);
  return attachReactions(rows);
}

export function updateMessage(id, content) {
  db.prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?').run(
    content,
    now(),
    id
  );
  return getMessageById(id);
}

export function deleteMessage(id) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export function toggleReaction(messageId, userId, emoji) {
  const existing = db
    .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, userId, emoji);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
      messageId,
      userId,
      emoji
    );
  } else {
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(
      messageId,
      userId,
      emoji
    );
  }
  return getMessageById(messageId);
}

export function searchMessages(userId, query, limit = 50) {
  const rows = db
    .prepare(
      `${MESSAGE_SELECT}
       JOIN channels c ON c.id = m.channel_id
       WHERE m.content LIKE ? ESCAPE '\\'
         AND (c.type = 'public'
              OR EXISTS (SELECT 1 FROM channel_members cm
                         WHERE cm.channel_id = c.id AND cm.user_id = ?))
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(`%${query.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`, userId, limit);
  return attachReactions(rows);
}

// ---------- seed ----------

export function closeDb() {
  try {
    db.close();
  } catch {
    // already closed
  }
}

export function seedDefaults() {
  if (!getChannelByName('general')) {
    db.prepare(
      `INSERT INTO channels (name, type, topic, created_by, created_at)
       VALUES ('general', 'public', '팀 전체 공지와 업무 대화', NULL, ?)`
    ).run(now());
  }
  if (!getChannelByName('random')) {
    db.prepare(
      `INSERT INTO channels (name, type, topic, created_by, created_at)
       VALUES ('random', 'public', '자유로운 잡담 공간', NULL, ?)`
    ).run(now());
  }
}

seedDefaults();
