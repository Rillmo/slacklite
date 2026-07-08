/* SlackLite client */
(() => {
  'use strict';

  const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

  const state = {
    token: localStorage.getItem('slacklite_token'),
    me: null,
    users: [],
    channels: [],
    dms: [],
    memberChannelIds: new Set(),
    unread: {},
    onlineUserIds: new Set(),
    currentChannel: null,
    messages: [],
    thread: null, // { parent, replies }
    editingId: null,
    typing: new Map(), // userId -> { name, timer }
    socket: null,
  };

  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDay(ts) {
    return new Date(ts).toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
  }

  function initial(name) {
    return esc((name || '?').trim().charAt(0).toUpperCase());
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...options.headers,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }

  // ---------- auth screen ----------

  let authMode = 'login';
  let inviteRequired = false;

  function setAuthMode(mode) {
    authMode = mode;
    $('tab-login').classList.toggle('active', mode === 'login');
    $('tab-register').classList.toggle('active', mode === 'register');
    $('field-display-name').classList.toggle('hidden', mode === 'login');
    $('field-invite').classList.toggle('hidden', mode === 'login' || !inviteRequired);
    $('auth-submit').textContent = mode === 'login' ? '로그인' : '회원가입';
    $('auth-error').classList.add('hidden');
  }

  $('tab-login').addEventListener('click', () => setAuthMode('login'));
  $('tab-register').addEventListener('click', () => setAuthMode('register'));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      username: $('auth-username').value,
      password: $('auth-password').value,
      displayName: $('auth-display-name').value,
      inviteCode: $('auth-invite').value,
    };
    try {
      const data = await api(`/${authMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      state.token = data.token;
      localStorage.setItem('slacklite_token', data.token);
      await enterApp();
    } catch (err) {
      const el = $('auth-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  });

  $('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('slacklite_token');
    location.reload();
  });

  // ---------- boot ----------

  async function enterApp() {
    const { user } = await api('/me');
    state.me = user;
    $('auth-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('me-name').textContent = user.display_name;
    const avatar = $('me-avatar');
    avatar.style.background = user.avatar_color;
    avatar.textContent = (user.display_name || '?').trim().charAt(0).toUpperCase();

    await refreshDirectory();
    connectSocket();

    const general = state.channels.find((c) => c.name === 'general') || state.channels[0];
    if (general) await openChannel(general.id);
  }

  async function refreshDirectory() {
    const [{ users }, channelData] = await Promise.all([api('/users'), api('/channels')]);
    state.users = users;
    state.channels = channelData.channels;
    state.dms = channelData.dms;
    state.memberChannelIds = new Set(channelData.memberChannelIds);
    state.unread = channelData.unread;
    renderSidebar();
  }

  // ---------- sidebar ----------

  function updateBadge() {
    if (!window.slacklite) return;
    const total = Object.values(state.unread).reduce((sum, n) => sum + (n || 0), 0);
    window.slacklite.setBadge(total);
  }

  function renderSidebar() {
    updateBadge();
    const current = state.currentChannel?.id;

    $('channel-list').innerHTML = state.channels
      .map((c) => {
        const unread = state.unread[c.id] || 0;
        const cls = [
          'sidebar-item',
          c.id === current ? 'active' : '',
          unread > 0 && c.id !== current ? 'unread' : '',
        ].join(' ');
        return `<li class="${cls}" data-channel="${c.id}">
          <span class="hash">#</span><span class="label">${esc(c.name)}</span>
          ${unread > 0 && c.id !== current ? `<span class="badge">${unread}</span>` : ''}
        </li>`;
      })
      .join('');

    const dmByPeer = new Map(state.dms.map((d) => [d.peer_id, d]));
    $('dm-list').innerHTML = state.users
      .filter((u) => u.id !== state.me.id)
      .map((u) => {
        const dm = dmByPeer.get(u.id);
        const unread = dm ? state.unread[dm.id] || 0 : 0;
        const active = dm && dm.id === current;
        const cls = [
          'sidebar-item',
          active ? 'active' : '',
          unread > 0 && !active ? 'unread' : '',
        ].join(' ');
        const online = state.onlineUserIds.has(u.id);
        return `<li class="${cls}" data-peer="${u.id}">
          <span class="presence-dot ${online ? 'online' : ''}"></span>
          <span class="label">${esc(u.display_name)}</span>
          ${unread > 0 && !active ? `<span class="badge">${unread}</span>` : ''}
        </li>`;
      })
      .join('');
  }

  $('channel-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-channel]');
    if (li) openChannel(Number(li.dataset.channel));
  });

  $('dm-list').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-peer]');
    if (!li) return;
    const { channel } = await api(`/dm/${li.dataset.peer}`, { method: 'POST' });
    await refreshDirectory();
    await openChannel(channel.id);
  });

  // ---------- channel view ----------

  async function openChannel(channelId) {
    const { channel, messages } = await api(`/channels/${channelId}/messages`);
    state.currentChannel = channel;
    state.messages = messages;
    state.memberChannelIds.add(channel.id);
    state.unread[channel.id] = 0;
    closeThread();
    closeSearch();
    renderChannelHeader();
    renderMessages();
    renderSidebar();
    $('composer-input').focus();
  }

  function channelDisplayName(channel) {
    if (channel.type !== 'dm') return `# ${channel.name}`;
    const dm = state.dms.find((d) => d.id === channel.id);
    return dm ? dm.peer_display_name : '다이렉트 메시지';
  }

  function renderChannelHeader() {
    const c = state.currentChannel;
    if (!c) return;
    $('channel-title').textContent = channelDisplayName(c);
    $('channel-topic').textContent = c.topic || '';
    $('channel-members').textContent =
      c.type === 'public' && c.member_count ? `멤버 ${c.member_count}명` : '';
    $('composer-input').placeholder =
      c.type === 'dm' ? `${channelDisplayName(c)}에게 메시지 보내기` : `#${c.name}에 메시지 보내기`;
  }

  // ---------- message rendering ----------

  function reactionsHtml(m) {
    if (!m.reactions?.length) return '';
    const chips = m.reactions
      .map((r) => {
        const mine = r.users.includes(state.me.id) ? 'mine' : '';
        return `<button class="reaction ${mine}" data-react="${esc(r.emoji)}" data-msg="${m.id}">
          ${esc(r.emoji)} <span>${r.count}</span></button>`;
      })
      .join('');
    return `<div class="reactions">${chips}</div>`;
  }

  function actionsHtml(m, inThread) {
    const emojiButtons = QUICK_EMOJIS.slice(0, 4)
      .map((e) => `<button data-react="${e}" data-msg="${m.id}" title="리액션">${e}</button>`)
      .join('');
    const threadBtn =
      !inThread && !m.parent_id
        ? `<button data-thread="${m.id}" title="스레드로 답글">💬</button>`
        : '';
    const ownBtns =
      m.user_id === state.me.id
        ? `<button data-edit="${m.id}" title="수정">✏️</button>
           <button data-delete="${m.id}" title="삭제">🗑️</button>`
        : '';
    return `<div class="message-actions">${emojiButtons}${threadBtn}${ownBtns}</div>`;
  }

  function messageHtml(m, opts = {}) {
    if (state.editingId === m.id && !opts.noEdit) {
      return `<div class="message" data-id="${m.id}">
        <span class="avatar" style="background:${esc(m.avatar_color)}">${initial(m.display_name)}</span>
        <div class="message-body edit-box">
          <textarea id="edit-input-${m.id}">${esc(m.content)}</textarea>
          <div class="edit-actions">
            <button class="edit-save" data-save="${m.id}">저장</button>
            <button class="edit-cancel" data-cancel="${m.id}">취소</button>
          </div>
        </div>
      </div>`;
    }
    const replyLink =
      !opts.inThread && m.reply_count > 0
        ? `<button class="reply-link" data-thread="${m.id}">답글 ${m.reply_count}개 →</button>`
        : '';
    const channelTag = opts.showChannel
      ? `<span class="message-channel-tag">${esc(opts.showChannel)}</span>`
      : '';
    return `<div class="message" data-id="${m.id}">
      <span class="avatar" style="background:${esc(m.avatar_color)}">${initial(m.display_name)}</span>
      <div class="message-body">
        <div class="message-meta">
          <span class="message-author">${esc(m.display_name)}</span>
          <span class="message-time">${fmtTime(m.created_at)}</span>
          ${m.updated_at ? '<span class="message-edited">(수정됨)</span>' : ''}
          ${channelTag}
        </div>
        <div class="message-content">${esc(m.content)}</div>
        ${reactionsHtml(m)}
        ${replyLink}
      </div>
      ${opts.readonly ? '' : actionsHtml(m, opts.inThread)}
    </div>`;
  }

  function renderMessages() {
    const list = $('message-list');
    if (state.messages.length === 0) {
      const c = state.currentChannel;
      list.innerHTML = `<div class="empty-state">
        <p><strong>${esc(channelDisplayName(c))}</strong> 대화의 시작입니다.</p>
        <p>첫 메시지를 남겨보세요 🎉</p>
      </div>`;
      return;
    }
    let html = '';
    let lastDay = '';
    for (const m of state.messages) {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) {
        html += `<div class="day-divider">${day}</div>`;
        lastDay = day;
      }
      html += messageHtml(m);
    }
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }

  // Shared click handling for message areas (reactions, thread, edit, delete).
  function handleMessageAreaClick(e) {
    const react = e.target.closest('[data-react]');
    if (react) {
      state.socket.emit('reaction:toggle', {
        messageId: Number(react.dataset.msg),
        emoji: react.dataset.react,
      });
      return;
    }
    const threadBtn = e.target.closest('[data-thread]');
    if (threadBtn) {
      openThread(Number(threadBtn.dataset.thread));
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      state.editingId = Number(editBtn.dataset.edit);
      renderMessages();
      renderThread();
      const input = $(`edit-input-${state.editingId}`);
      if (input) { input.focus(); input.selectionStart = input.value.length; }
      return;
    }
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn) {
      const id = Number(saveBtn.dataset.save);
      const content = $(`edit-input-${id}`).value.trim();
      if (content) state.socket.emit('message:edit', { messageId: id, content });
      state.editingId = null;
      renderMessages();
      renderThread();
      return;
    }
    const cancelBtn = e.target.closest('[data-cancel]');
    if (cancelBtn) {
      state.editingId = null;
      renderMessages();
      renderThread();
      return;
    }
    const deleteBtn = e.target.closest('[data-delete]');
    if (deleteBtn && confirm('이 메시지를 삭제할까요?')) {
      state.socket.emit('message:delete', { messageId: Number(deleteBtn.dataset.delete) });
    }
  }

  $('message-list').addEventListener('click', handleMessageAreaClick);
  $('thread-messages').addEventListener('click', handleMessageAreaClick);

  // ---------- composer ----------

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  function sendFrom(textarea, parentId = null) {
    const content = textarea.value.trim();
    if (!content || !state.currentChannel) return;
    state.socket.emit(
      'message:send',
      { channelId: state.currentChannel.id, content, parentId },
      (res) => { if (res?.error) alert(res.error); }
    );
    textarea.value = '';
    autosize(textarea);
  }

  function wireComposer(textarea, sendBtn, getParentId) {
    textarea.addEventListener('input', () => {
      autosize(textarea);
      if (state.currentChannel) {
        state.socket.emit('typing', { channelId: state.currentChannel.id });
      }
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendFrom(textarea, getParentId());
      }
    });
    sendBtn.addEventListener('click', () => sendFrom(textarea, getParentId()));
  }

  wireComposer($('composer-input'), $('composer-send'), () => null);
  wireComposer($('thread-input'), $('thread-send'), () => state.thread?.parent.id ?? null);

  // ---------- thread panel ----------

  async function openThread(messageId) {
    const { parent, replies } = await api(`/messages/${messageId}/thread`);
    state.thread = { parent, replies };
    closeSearch();
    $('thread-panel').classList.remove('hidden');
    renderThread();
    $('thread-input').focus();
  }

  function renderThread() {
    if (!state.thread) return;
    const { parent, replies } = state.thread;
    $('thread-messages').innerHTML =
      messageHtml(parent, { inThread: true }) +
      `<div class="thread-parent-divider">답글 ${replies.length}개</div>` +
      replies.map((m) => messageHtml(m, { inThread: true })).join('');
    const box = $('thread-messages');
    box.scrollTop = box.scrollHeight;
  }

  function closeThread() {
    state.thread = null;
    $('thread-panel').classList.add('hidden');
  }

  $('btn-close-thread').addEventListener('click', closeThread);

  // ---------- search ----------

  $('search-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const q = e.target.value.trim();
    if (!q) return;
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    closeThread();
    $('search-panel').classList.remove('hidden');
    $('search-title').textContent = `"${q}" 검색 결과 ${results.length}건`;
    $('search-results').innerHTML = results.length
      ? results
          .map((m) => {
            const ch = state.channels.find((c) => c.id === m.channel_id);
            return messageHtml(m, { readonly: true, showChannel: ch ? `#${ch.name}` : 'DM' });
          })
          .join('')
      : '<div class="empty-state">검색 결과가 없습니다.</div>';
  });

  $('btn-close-search').addEventListener('click', closeSearch);
  function closeSearch() {
    $('search-panel').classList.add('hidden');
  }

  // ---------- new channel modal ----------

  $('btn-new-channel').addEventListener('click', () => {
    $('modal-backdrop').classList.remove('hidden');
    $('new-channel-error').classList.add('hidden');
    $('new-channel-name').value = '';
    $('new-channel-topic').value = '';
    $('new-channel-name').focus();
  });

  $('btn-cancel-channel').addEventListener('click', () =>
    $('modal-backdrop').classList.add('hidden')
  );
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) $('modal-backdrop').classList.add('hidden');
  });

  $('new-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { channel } = await api('/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: $('new-channel-name').value,
          topic: $('new-channel-topic').value,
        }),
      });
      $('modal-backdrop').classList.add('hidden');
      await refreshDirectory();
      await openChannel(channel.id);
    } catch (err) {
      const el = $('new-channel-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  });

  // ---------- socket ----------

  function maybeNotify(m) {
    if (m.user_id === state.me.id) return;
    if (!('Notification' in window)) return;
    const viewingHere =
      document.hasFocus() && state.currentChannel && m.channel_id === state.currentChannel.id;
    if (viewingHere) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
      return;
    }
    if (Notification.permission !== 'granted') return;
    const n = new Notification(m.display_name, {
      body: m.content.length > 140 ? `${m.content.slice(0, 140)}…` : m.content,
      tag: `slacklite-${m.channel_id}`,
    });
    n.onclick = () => {
      window.slacklite?.focusWindow();
      window.focus();
      openChannel(m.channel_id);
    };
  }

  function connectSocket() {
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('message:new', (m) => {
      maybeNotify(m);
      const inCurrent = state.currentChannel && m.channel_id === state.currentChannel.id;

      if (inCurrent && !m.parent_id) {
        state.messages.push(m);
        renderMessages();
        socket.emit('channel:read', { channelId: m.channel_id });
      } else if (!inCurrent) {
        if (m.user_id !== state.me.id) {
          state.unread[m.channel_id] = (state.unread[m.channel_id] || 0) + 1;
        }
        // A DM channel we've never seen — refresh the sidebar list.
        if (
          !state.channels.some((c) => c.id === m.channel_id) &&
          !state.dms.some((d) => d.id === m.channel_id)
        ) {
          refreshDirectory();
          return;
        }
        renderSidebar();
      }

      if (m.parent_id) {
        // Update reply count on the parent message in the main view.
        const parent = state.messages.find((x) => x.id === m.parent_id);
        if (parent) {
          parent.reply_count = (parent.reply_count || 0) + 1;
          if (inCurrent) renderMessages();
        }
        if (state.thread && state.thread.parent.id === m.parent_id) {
          state.thread.replies.push(m);
          renderThread();
          if (inCurrent) socket.emit('channel:read', { channelId: m.channel_id });
        }
      }

      clearTypingFor(m.user_id);
    });

    socket.on('message:update', (m) => {
      const idx = state.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        state.messages[idx] = { ...state.messages[idx], ...m };
        renderMessages();
      }
      if (state.thread) {
        if (state.thread.parent.id === m.id) {
          state.thread.parent = { ...state.thread.parent, ...m };
          renderThread();
        }
        const ridx = state.thread.replies.findIndex((x) => x.id === m.id);
        if (ridx >= 0) {
          state.thread.replies[ridx] = { ...state.thread.replies[ridx], ...m };
          renderThread();
        }
      }
    });

    socket.on('message:delete', ({ id, parent_id }) => {
      const before = state.messages.length;
      state.messages = state.messages.filter((m) => m.id !== id);
      if (parent_id) {
        const parent = state.messages.find((m) => m.id === parent_id);
        if (parent && parent.reply_count > 0) parent.reply_count -= 1;
      }
      if (state.messages.length !== before || parent_id) renderMessages();
      if (state.thread) {
        if (state.thread.parent.id === id) closeThread();
        else {
          const rBefore = state.thread.replies.length;
          state.thread.replies = state.thread.replies.filter((m) => m.id !== id);
          if (state.thread.replies.length !== rBefore) renderThread();
        }
      }
    });

    socket.on('presence', (userIds) => {
      state.onlineUserIds = new Set(userIds);
      renderSidebar();
    });

    socket.on('typing', ({ channelId, userId, displayName }) => {
      if (!state.currentChannel || channelId !== state.currentChannel.id) return;
      if (userId === state.me.id) return;
      const existing = state.typing.get(userId);
      if (existing) clearTimeout(existing.timer);
      state.typing.set(userId, {
        name: displayName,
        timer: setTimeout(() => clearTypingFor(userId), 3000),
      });
      renderTyping();
    });

    socket.on('user:new', () => refreshDirectory());
    socket.on('channel:new', () => refreshDirectory());
    socket.on('dm:new', () => refreshDirectory());

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        localStorage.removeItem('slacklite_token');
        location.reload();
      }
    });
  }

  function clearTypingFor(userId) {
    const entry = state.typing.get(userId);
    if (entry) {
      clearTimeout(entry.timer);
      state.typing.delete(userId);
      renderTyping();
    }
  }

  function renderTyping() {
    const names = [...state.typing.values()].map((t) => t.name);
    $('typing-indicator').textContent =
      names.length === 0
        ? ''
        : names.length === 1
          ? `${names[0]}님이 입력 중...`
          : `${names.length}명이 입력 중...`;
  }

  // ---------- desktop (Electron) integration ----------

  if (window.slacklite) {
    document.body.classList.add('electron');
    window.slacklite.onNewChannel(() => $('btn-new-channel').click());
  }

  // ---------- start ----------

  (async () => {
    api('/meta')
      .then((meta) => {
        inviteRequired = Boolean(meta.inviteRequired);
        if (authMode === 'register') setAuthMode('register');
      })
      .catch(() => {});
    if (state.token) {
      try {
        await enterApp();
        return;
      } catch {
        localStorage.removeItem('slacklite_token');
        state.token = null;
      }
    }
    $('auth-screen').classList.remove('hidden');
  })();
})();
