import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient } from 'socket.io-client';

// Isolate test data before the server modules are imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacklite-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.SECRET_PATH = path.join(tmpDir, '.jwt-secret');
delete process.env.INVITE_CODE;

const { startServer } = await import('../server/app.js');
const { closeDb } = await import('../server/db.js');

const server = await startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;
const sockets = [];

after(() => {
  for (const s of sockets) s.disconnect();
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, { auth: { token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

let aliceToken;
let bobToken;
let bobId;

test('healthz responds', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

test('register creates user and joins default channels', async () => {
  const { status, data } = await api('/register', {
    method: 'POST',
    body: { username: 'alice', password: 'pass1234', displayName: 'Alice' },
  });
  assert.equal(status, 200);
  assert.ok(data.token);
  aliceToken = data.token;

  const channels = await api('/channels', { token: aliceToken });
  const names = channels.data.channels.map((c) => c.name);
  assert.ok(names.includes('general'));
  assert.ok(names.includes('random'));
  assert.ok(channels.data.memberChannelIds.length >= 2);
});

test('register rejects duplicate username and bad input', async () => {
  const dup = await api('/register', {
    method: 'POST',
    body: { username: 'alice', password: 'pass1234' },
  });
  assert.equal(dup.status, 409);

  const bad = await api('/register', {
    method: 'POST',
    body: { username: 'X!', password: 'pass1234' },
  });
  assert.equal(bad.status, 400);
});

test('login verifies password', async () => {
  const ok = await api('/login', {
    method: 'POST',
    body: { username: 'alice', password: 'pass1234' },
  });
  assert.equal(ok.status, 200);

  const wrong = await api('/login', {
    method: 'POST',
    body: { username: 'alice', password: 'nope' },
  });
  assert.equal(wrong.status, 401);
});

test('unauthenticated API access is rejected', async () => {
  const res = await api('/channels');
  assert.equal(res.status, 401);
});

test('invite code is enforced when configured', async () => {
  process.env.INVITE_CODE = 'sesame';
  try {
    const meta = await api('/meta');
    assert.equal(meta.data.inviteRequired, true);

    const denied = await api('/register', {
      method: 'POST',
      body: { username: 'bob', password: 'pass1234' },
    });
    assert.equal(denied.status, 403);

    const ok = await api('/register', {
      method: 'POST',
      body: { username: 'bob', password: 'pass1234', displayName: 'Bob', inviteCode: 'sesame' },
    });
    assert.equal(ok.status, 200);
    bobToken = ok.data.token;
    bobId = ok.data.user.id;
  } finally {
    delete process.env.INVITE_CODE;
  }
});

test('messages flow in real time over sockets', async () => {
  const alice = await connectSocket(aliceToken);
  const bob = await connectSocket(bobToken);

  const channels = await api('/channels', { token: aliceToken });
  const general = channels.data.channels.find((c) => c.name === 'general');

  const received = waitFor(bob, 'message:new');
  alice.emit('message:send', { channelId: general.id, content: 'hello bob!' });
  const message = await received;
  assert.equal(message.content, 'hello bob!');

  // Thread reply updates reply metadata.
  const replyReceived = waitFor(bob, 'message:new');
  alice.emit('message:send', {
    channelId: general.id,
    content: 'threaded reply',
    parentId: message.id,
  });
  const reply = await replyReceived;
  assert.equal(reply.parent_id, message.id);

  const thread = await api(`/messages/${message.id}/thread`, { token: bobToken });
  assert.equal(thread.data.replies.length, 1);

  // Reaction toggle broadcasts an update.
  const updated = waitFor(bob, 'message:update');
  alice.emit('reaction:toggle', { messageId: message.id, emoji: '👍' });
  const withReaction = await updated;
  assert.equal(withReaction.reactions[0].emoji, '👍');
  assert.equal(withReaction.reactions[0].count, 1);
});

test('non-members cannot post to a channel', async () => {
  const alice = await connectSocket(aliceToken);
  const ack = await new Promise((resolve) =>
    alice.emit('message:send', { channelId: 999, content: 'nope' }, resolve)
  );
  assert.ok(ack.error);
});

test('DM channels are private', async () => {
  const dm = await api(`/dm/${bobId}`, { token: aliceToken, method: 'POST' });
  assert.equal(dm.status, 200);
  const channelId = dm.data.channel.id;

  // Third user cannot read the DM.
  const carol = await api('/register', {
    method: 'POST',
    body: { username: 'carol', password: 'pass1234' },
  });
  const denied = await api(`/channels/${channelId}/messages`, { token: carol.data.token });
  assert.equal(denied.status, 403);

  const allowed = await api(`/channels/${channelId}/messages`, { token: bobToken });
  assert.equal(allowed.status, 200);
});

test('unread counts and read markers', async () => {
  const channels = await api('/channels', { token: aliceToken });
  const general = channels.data.channels.find((c) => c.name === 'general');

  const alice = await connectSocket(aliceToken);
  alice.emit('message:send', { channelId: general.id, content: 'unread test' });
  await new Promise((r) => setTimeout(r, 200));

  const bobBefore = await api('/channels', { token: bobToken });
  assert.ok(bobBefore.data.unread[general.id] >= 1);

  await api(`/channels/${general.id}/read`, { token: bobToken, method: 'POST' });
  const bobAfter = await api('/channels', { token: bobToken });
  assert.equal(bobAfter.data.unread[general.id], 0);
});

test('search finds messages', async () => {
  const found = await api('/search?q=unread%20test', { token: aliceToken });
  assert.equal(found.status, 200);
  assert.ok(found.data.results.some((m) => m.content === 'unread test'));
});

test('message edit and delete are owner-only', async () => {
  const channels = await api('/channels', { token: aliceToken });
  const general = channels.data.channels.find((c) => c.name === 'general');
  const alice = await connectSocket(aliceToken);
  const bob = await connectSocket(bobToken);

  const sent = await new Promise((resolve) =>
    alice.emit('message:send', { channelId: general.id, content: 'to edit' }, resolve)
  );
  const messageId = sent.message.id;

  const denied = await new Promise((resolve) =>
    bob.emit('message:edit', { messageId, content: 'hijack' }, resolve)
  );
  assert.ok(denied.error);

  const edited = await new Promise((resolve) =>
    alice.emit('message:edit', { messageId, content: 'edited!' }, resolve)
  );
  assert.equal(edited.message.content, 'edited!');
  assert.ok(edited.message.updated_at);

  const deleteDenied = await new Promise((resolve) =>
    bob.emit('message:delete', { messageId }, resolve)
  );
  assert.ok(deleteDenied.error);

  const deleted = await new Promise((resolve) =>
    alice.emit('message:delete', { messageId }, resolve)
  );
  assert.ok(deleted.ok);
});
