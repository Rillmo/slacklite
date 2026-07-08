import * as db from './db.js';
import { socketAuth } from './auth.js';

const MAX_MESSAGE_LENGTH = 4000;

export function setupSockets(io) {
  // userId -> Set of socket ids, for presence tracking
  const online = new Map();

  io.use(socketAuth);

  io.on('connection', (socket) => {
    const user = socket.user;

    socket.join(`user:${user.id}`);
    for (const channelId of db.listMemberChannelIds(user.id)) {
      socket.join(`channel:${channelId}`);
    }

    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    io.emit('presence', [...online.keys()]);

    socket.on('message:send', (payload, ack) => {
      try {
        const channelId = Number(payload?.channelId);
        const content = String(payload?.content ?? '').trim();
        const parentId = payload?.parentId ? Number(payload.parentId) : null;
        if (!content || content.length > MAX_MESSAGE_LENGTH) return ack?.({ error: '메시지 내용이 올바르지 않습니다.' });
        if (!db.isMember(channelId, user.id)) return ack?.({ error: '채널 멤버가 아닙니다.' });
        if (parentId) {
          const parent = db.getMessageById(parentId);
          if (!parent || parent.channel_id !== channelId || parent.parent_id) {
            return ack?.({ error: '스레드 원본 메시지를 찾을 수 없습니다.' });
          }
        }
        const message = db.createMessage(channelId, user.id, content, parentId);
        db.markRead(channelId, user.id);
        io.to(`channel:${channelId}`).emit('message:new', message);
        ack?.({ message });
      } catch (err) {
        console.error('message:send failed', err);
        ack?.({ error: '메시지 전송에 실패했습니다.' });
      }
    });

    socket.on('message:edit', (payload, ack) => {
      const message = db.getMessageById(Number(payload?.messageId));
      const content = String(payload?.content ?? '').trim();
      if (!message || message.user_id !== user.id) return ack?.({ error: '수정 권한이 없습니다.' });
      if (!content || content.length > MAX_MESSAGE_LENGTH) return ack?.({ error: '메시지 내용이 올바르지 않습니다.' });
      const updated = db.updateMessage(message.id, content);
      io.to(`channel:${message.channel_id}`).emit('message:update', updated);
      ack?.({ message: updated });
    });

    socket.on('message:delete', (payload, ack) => {
      const message = db.getMessageById(Number(payload?.messageId));
      if (!message || message.user_id !== user.id) return ack?.({ error: '삭제 권한이 없습니다.' });
      db.deleteMessage(message.id);
      io.to(`channel:${message.channel_id}`).emit('message:delete', {
        id: message.id,
        channel_id: message.channel_id,
        parent_id: message.parent_id,
      });
      ack?.({ ok: true });
    });

    socket.on('reaction:toggle', (payload, ack) => {
      const message = db.getMessageById(Number(payload?.messageId));
      const emoji = String(payload?.emoji ?? '');
      if (!message || !emoji || emoji.length > 16) return ack?.({ error: '리액션을 처리할 수 없습니다.' });
      if (!db.isMember(message.channel_id, user.id)) return ack?.({ error: '채널 멤버가 아닙니다.' });
      const updated = db.toggleReaction(message.id, user.id, emoji);
      io.to(`channel:${message.channel_id}`).emit('message:update', updated);
      ack?.({ message: updated });
    });

    socket.on('typing', (payload) => {
      const channelId = Number(payload?.channelId);
      if (!db.isMember(channelId, user.id)) return;
      socket.to(`channel:${channelId}`).emit('typing', {
        channelId,
        userId: user.id,
        displayName: user.display_name,
      });
    });

    socket.on('channel:read', (payload) => {
      const channelId = Number(payload?.channelId);
      if (!db.isMember(channelId, user.id)) return;
      db.markRead(channelId, user.id);
    });

    socket.on('disconnect', () => {
      const sockets = online.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) online.delete(user.id);
      }
      io.emit('presence', [...online.keys()]);
    });
  });
}
