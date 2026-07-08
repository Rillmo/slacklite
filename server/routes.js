import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as db from './db.js';
import { signToken, requireAuth } from './auth.js';
import { rateLimit } from './ratelimit.js';

export function createRoutes(io) {
  const router = Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 });

  // ---------- public ----------

  // Instance metadata for the client (no auth required).
  router.get('/meta', (req, res) => {
    res.json({ inviteRequired: Boolean(process.env.INVITE_CODE) });
  });

  router.post('/register', authLimiter, async (req, res) => {
    const { username, password, displayName, inviteCode } = req.body ?? {};
    if (process.env.INVITE_CODE && String(inviteCode ?? '') !== process.env.INVITE_CODE) {
      return res.status(403).json({ error: '초대 코드가 올바르지 않습니다.' });
    }
    const name = String(username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(name)) {
      return res
        .status(400)
        .json({ error: '아이디는 2~32자의 영문 소문자, 숫자, _.- 만 사용할 수 있습니다.' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
    }
    if (db.getUserByUsername(name)) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }
    const display = String(displayName ?? '').trim() || name;
    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser(name, display, hash);

    // Everyone starts in the default public channels, like Slack's #general.
    for (const channelName of ['general', 'random']) {
      const channel = db.getChannelByName(channelName);
      if (channel) db.addMember(channel.id, user.id);
    }

    io.emit('user:new', db.publicUser(user));
    res.json({ token: signToken(user), user: db.publicUser(user) });
  });

  router.post('/login', authLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};
    const user = db.getUserByUsername(String(username ?? '').trim().toLowerCase());
    if (!user || !(await bcrypt.compare(String(password ?? ''), user.password_hash))) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    res.json({ token: signToken(user), user: db.publicUser(user) });
  });

  // Everything below requires a valid token.
  router.use(requireAuth);

  router.get('/me', (req, res) => {
    res.json({ user: db.publicUser(req.user) });
  });

  router.get('/users', (req, res) => {
    res.json({ users: db.listUsers() });
  });

  // ---------- channels ----------

  router.get('/channels', (req, res) => {
    res.json({
      channels: db.listPublicChannels(),
      dms: db.listDmChannels(req.user.id),
      memberChannelIds: db.listMemberChannelIds(req.user.id),
      unread: db.unreadCounts(req.user.id),
    });
  });

  router.post('/channels', (req, res) => {
    const raw = String(req.body?.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9가-힣_-]{1,40}$/.test(raw)) {
      return res.status(400).json({ error: '채널 이름은 1~40자의 한글, 영문 소문자, 숫자, -_ 만 사용할 수 있습니다.' });
    }
    if (db.getChannelByName(raw)) {
      return res.status(409).json({ error: '이미 존재하는 채널 이름입니다.' });
    }
    const topic = String(req.body?.topic ?? '').trim().slice(0, 200);
    const channel = db.createChannel(raw, req.user.id, topic);
    io.in(`user:${req.user.id}`).socketsJoin(`channel:${channel.id}`);
    io.emit('channel:new', channel);
    res.json({ channel });
  });

  router.post('/channels/:id/join', (req, res) => {
    const channel = db.getChannelById(Number(req.params.id));
    if (!channel || channel.type !== 'public') {
      return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });
    }
    db.addMember(channel.id, req.user.id);
    io.in(`user:${req.user.id}`).socketsJoin(`channel:${channel.id}`);
    res.json({ channel });
  });

  router.post('/channels/:id/read', (req, res) => {
    const channelId = Number(req.params.id);
    if (!db.isMember(channelId, req.user.id)) {
      return res.status(403).json({ error: '채널 멤버가 아닙니다.' });
    }
    db.markRead(channelId, req.user.id);
    res.json({ ok: true });
  });

  router.get('/channels/:id/messages', (req, res) => {
    const channelId = Number(req.params.id);
    const channel = db.getChannelById(channelId);
    if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });
    const member = db.isMember(channelId, req.user.id);
    if (channel.type === 'dm' && !member) {
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    // Opening a public channel joins it, like clicking a channel in Slack's browser.
    if (!member && channel.type === 'public') {
      db.addMember(channelId, req.user.id);
      io.in(`user:${req.user.id}`).socketsJoin(`channel:${channelId}`);
    }
    db.markRead(channelId, req.user.id);
    res.json({
      channel: { ...channel, member_count: db.countMembers(channelId) },
      messages: db.getChannelMessages(channelId),
    });
  });

  router.get('/messages/:id/thread', (req, res) => {
    const parent = db.getMessageById(Number(req.params.id));
    if (!parent) return res.status(404).json({ error: '메시지를 찾을 수 없습니다.' });
    const channel = db.getChannelById(parent.channel_id);
    if (channel.type === 'dm' && !db.isMember(channel.id, req.user.id)) {
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    res.json({ parent, replies: db.getThreadMessages(parent.id) });
  });

  // ---------- DM ----------

  router.post('/dm/:userId', (req, res) => {
    const peerId = Number(req.params.userId);
    const peer = db.getUserById(peerId);
    if (!peer || peerId === req.user.id) {
      return res.status(400).json({ error: '대상 사용자를 찾을 수 없습니다.' });
    }
    const { channel, created } = db.getOrCreateDm(req.user.id, peerId);
    io.in(`user:${req.user.id}`).socketsJoin(`channel:${channel.id}`);
    io.in(`user:${peerId}`).socketsJoin(`channel:${channel.id}`);
    if (created) {
      io.in(`user:${peerId}`).emit('dm:new');
    }
    res.json({ channel, peer: db.publicUser(peer) });
  });

  // ---------- search ----------

  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ results: [] });
    res.json({ results: db.searchMessages(req.user.id, q) });
  });

  return router;
}
