import { adminToken, clearAdminSession, NotEnrolledError } from '../adminAuth.ts';
import type { Message } from '../api.ts';
import { clear, h, icon } from '../dom.ts';
import { navigate } from '../nav.ts';
import { RoomConnection, type ConnectionState, type PendingMessage, type PresenceEntry } from '../realtime.ts';
import { forgetRoomSession, getRoomSession, leaveRoom } from '../sessions.ts';
import { dayLabel, dialog, formatDateTime, formatTime, iconButton, initials, senderHue, toast } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

const MAX_CHARS = 4000;
const GROUP_GAP_MS = 5 * 60_000;
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;

export function renderChat(root: HTMLElement, opts: { roomId: string; asAdmin: boolean }): (() => void) | void {
  const session = opts.asAdmin ? undefined : getRoomSession(opts.roomId);
  if (!opts.asAdmin && !session) {
    root.append(
      appBar({ title: 'Cameră', back: '/' }),
      page(card(h('h2', null, 'Nu ești în această cameră'), h('p', null, 'Intră folosind codul și parola primite de la administrator.'), h('a', { class: 'btn btn-primary', href: '#/join' }, 'Intră într-o cameră'))),
    );
    return;
  }

  const mySenderId = opts.asAdmin ? 'admin' : session!.participantId;
  const messages = new Map<string, Message>();
  let pending: PendingMessage[] = [];
  let online: PresenceEntry[] = [];
  let hasOlder = false;
  let loadingOlder = false;
  let roomClosed = false;
  let unread = 0;
  const baseTitle = document.title;

  // ---- structură ----
  const title = h('span', null, session?.roomName ?? 'Se încarcă…');
  const subtitle = h('span', { class: 'conn', 'data-testid': 'conn-status' }, 'Se conectează…');
  const roomAvatar = h('span', { class: 'avatar avatar-sm', style: { '--hue': senderHue(opts.roomId) } }, initials(session?.roomName ?? '?'));
  const banner = h('div', { class: 'conn-banner', hidden: true, role: 'status' });
  const list = h('div', { class: 'messages', role: 'log', 'aria-label': 'Istoricul mesajelor', tabindex: '0' });
  const olderBtn = h('button', { class: 'btn btn-small older-btn', type: 'button', hidden: true }, 'Încarcă mesaje mai vechi');
  const scroller = h('div', { class: 'chat-scroll' }, olderBtn, list);
  const textarea = h('textarea', { rows: 1, placeholder: 'Scrie un mesaj', 'aria-label': 'Scrie un mesaj', maxlength: MAX_CHARS, enterkeyhint: 'send' });
  const counter = h('span', { class: 'counter', hidden: true });
  const sendBtn = h('button', { class: 'send-btn', type: 'submit', 'aria-label': 'Trimite', title: 'Trimite' }, icon('send'));
  const composer = h('form', { class: 'composer' }, h('div', { class: 'composer-input' }, textarea, counter), sendBtn);
  const closedNote = h('div', { class: 'closed-note', hidden: true }, 'Camera este închisă. Nu se mai pot trimite mesaje.');
  const peopleList = h('ul', { class: 'people-list', 'data-testid': 'people-list' });
  const panel = h(
    'aside',
    { class: 'side-panel', hidden: true, 'aria-label': 'Participanți' },
    h('div', { class: 'side-head' }, h('h2', null, 'Participanți online'), iconButton('close', 'Închide', () => togglePanel(false))),
    peopleList,
    opts.asAdmin ? h('p', { class: 'muted small' }, 'Lista completă și revocarea accesului sunt în panoul de administrare.') : null,
  );

  const actions = [iconButton('people', 'Participanți', () => togglePanel(Boolean(panel.hidden)))];
  if (!opts.asAdmin) actions.push(iconButton('logout', 'Ieși din cameră', () => void confirmLeave()));

  root.append(
    h(
      'div',
      { class: 'chat' },
      appBar({ title: h('span', { class: 'title-with-avatar' }, roomAvatar, title), subtitle, back: opts.asAdmin ? '/admin' : '/', actions }),
      banner,
      h('div', { class: 'chat-body' }, h('main', { class: 'chat-main' }, scroller, closedNote, composer), panel),
    ),
  );

  function togglePanel(show: boolean) {
    panel.hidden = !show;
  }

  // ---- afișare mesaje ----
  function nearBottom(): boolean {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }

  function render(mode: 'bottom' | 'keep' | 'auto' = 'auto') {
    const stick = mode === 'bottom' || (mode === 'auto' && nearBottom());
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    clear(list);
    const sorted = [...messages.values()].sort((a, b) => a.seq - b.seq);
    let prev: { senderId: string; createdAt: number } | null = null;
    let prevDay = '';
    if (sorted.length === 0 && pending.length === 0) {
      list.append(h('p', { class: 'empty-chat' }, 'Niciun mesaj încă. Scrie primul mesaj!'));
    }
    for (const m of sorted) {
      const day = dayLabel(m.createdAt);
      if (day !== prevDay) {
        list.append(h('div', { class: 'day-sep' }, h('span', null, day)));
        prevDay = day;
        prev = null;
      }
      const startsGroup = !prev || prev.senderId !== m.senderId || m.createdAt - prev.createdAt > GROUP_GAP_MS;
      list.append(messageEl(m, startsGroup));
      prev = m;
    }
    for (const p of pending) list.append(pendingEl(p));
    olderBtn.hidden = !hasOlder;
    if (stick) scroller.scrollTop = scroller.scrollHeight;
    else if (mode === 'keep') scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  }

  function messageEl(m: Message, startsGroup: boolean): HTMLElement {
    const own = m.senderId === mySenderId;
    return h(
      'div',
      { class: `msg ${own ? 'msg-own' : ''} ${startsGroup ? 'msg-first' : ''}`, 'data-testid': 'message', 'data-seq': m.seq },
      h(
        'div',
        { class: 'bubble' },
        !own && startsGroup
          ? h(
              'div',
              { class: 'sender', style: { '--hue': senderHue(m.senderId) } },
              m.senderName,
              m.senderKind === 'admin' ? h('span', { class: 'badge' }, 'admin') : null,
            )
          : null,
        h('div', { class: 'body' }, ...linkify(m.body)),
        h('div', { class: 'meta' }, h('time', { datetime: new Date(m.createdAt).toISOString(), title: formatDateTime(m.createdAt) }, formatTime(m.createdAt)), own ? icon('check', 'Salvat pe server') : null),
      ),
    );
  }

  function pendingEl(p: PendingMessage): HTMLElement {
    return h(
      'div',
      { class: 'msg msg-own msg-pending', 'data-testid': 'pending-message' },
      h('div', { class: 'bubble' }, h('div', { class: 'body' }, ...linkify(p.body)), h('div', { class: 'meta' }, formatTime(p.createdAt), icon('clock', 'În așteptare'))),
    );
  }

  function renderPeople() {
    clear(peopleList);
    for (const p of online) {
      peopleList.append(
        h(
          'li',
          null,
          h('span', { class: 'avatar avatar-sm', style: { '--hue': senderHue(p.senderId) } }, initials(p.displayName)),
          h('span', null, p.displayName, p.senderId === mySenderId ? ' (tu)' : ''),
          p.senderKind === 'admin' ? h('span', { class: 'badge' }, 'admin') : null,
        ),
      );
    }
    if (online.length === 0) peopleList.append(h('li', { class: 'muted' }, 'Nimeni online.'));
  }

  function setStatus(s: ConnectionState) {
    banner.hidden = true;
    banner.className = 'conn-banner';
    switch (s.kind) {
      case 'connecting':
        subtitle.textContent = s.attempt > 1 ? 'Se reconectează…' : 'Se conectează…';
        break;
      case 'online':
        updateOnlineSubtitle();
        if (pending.length > 0) render();
        break;
      case 'offline': {
        subtitle.textContent = 'Deconectat';
        banner.hidden = false;
        banner.classList.add('conn-warn');
        const sec = Math.ceil(s.retryInMs / 1000);
        banner.textContent = `Fără legătură cu serverul. Reîncerc în ${sec} s. ${pending.length > 0 ? 'Mesajele tale sunt păstrate și vor fi trimise automat.' : ''}`;
        break;
      }
      case 'ended':
        endSession(s.reason);
        break;
    }
  }

  function updateOnlineSubtitle() {
    const names = online.filter((p) => p.senderId !== mySenderId).map((p) => p.displayName);
    subtitle.textContent = names.length === 0 ? 'online' : names.length <= 3 ? `online: ${names.join(', ')}` : `${names.length + 1} online`;
  }

  function endSession(reason: string) {
    composer.hidden = true;
    subtitle.textContent = 'Deconectat';
    banner.hidden = false;
    banner.className = 'conn-banner conn-error';
    clear(banner);
    if (opts.asAdmin) {
      banner.append('Sesiunea de administrator nu mai este validă. ', h('a', { href: '#/admin' }, 'Autentifică-te din nou'));
      return;
    }
    forgetRoomSession(opts.roomId);
    banner.append(
      reason === 'revoked'
        ? 'Accesul tău în această cameră a fost revocat sau camera a fost închisă. '
        : 'Sesiunea ta a expirat. ',
      h('a', { href: `#/join/${session!.roomCode}` }, 'Intră din nou'),
    );
  }

  // ---- conexiune ----
  const conn = new RoomConnection(
    opts.roomId,
    opts.asAdmin ? adminToken : async () => session!.token,
    {
      state: setStatus,
      room(info) {
        title.textContent = info.name;
        roomAvatar.textContent = initials(info.name);
        roomClosed = info.closedAt !== null;
        closedNote.hidden = !roomClosed;
        composer.hidden = roomClosed;
      },
      messages(batch, { older, hasMore }) {
        const fresh = batch.filter((m) => !messages.has(m.id));
        for (const m of batch) messages.set(m.id, m);
        if (older) {
          hasOlder = hasMore;
          loadingOlder = false;
          return render('keep');
        }
        if (messages.size === batch.length) hasOlder = hasMore; // prima încărcare
        if (document.visibilityState === 'hidden') {
          unread += fresh.filter((m) => m.senderId !== mySenderId).length;
          if (unread > 0) document.title = `(${unread}) ${baseTitle}`;
        }
        render(messages.size === batch.length ? 'bottom' : 'auto');
      },
      confirmed(clientMsgId, message) {
        pending = pending.filter((p) => p.clientMsgId !== clientMsgId);
        messages.set(message.id, message);
        render('bottom');
      },
      presence(list) {
        online = list;
        renderPeople();
        updateOnlineSubtitle();
      },
      error(message, code) {
        if (code !== 'session_revoked') toast(message, 'error');
        pending = conn.pending();
        render();
      },
    },
    opts.asAdmin
      ? () => {
          clearAdminSession();
          return true;
        }
      : undefined,
  );

  // ---- interacțiuni ----
  function submit() {
    const body = textarea.value.trim();
    if (!body || roomClosed) return;
    if ([...body].length > MAX_CHARS) return toast(`Mesajul depășește ${MAX_CHARS} caractere.`, 'error');
    conn.send(body);
    pending = conn.pending();
    textarea.value = '';
    autoGrow();
    render('bottom');
    textarea.focus();
  }

  function autoGrow() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    const len = [...textarea.value].length;
    counter.hidden = len < MAX_CHARS - 500;
    counter.textContent = `${len}/${MAX_CHARS}`;
  }

  composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  textarea.addEventListener('input', autoGrow);
  textarea.addEventListener('keydown', (ev) => {
    // Pe desktop Enter trimite (Shift+Enter = rând nou); pe telefon Enter = rând nou.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !matchMedia('(pointer: coarse)').matches) {
      ev.preventDefault();
      submit();
    }
  });
  olderBtn.addEventListener('click', () => {
    const first = [...messages.values()].reduce((min, m) => Math.min(min, m.seq), Infinity);
    if (loadingOlder || !Number.isFinite(first)) return;
    loadingOlder = true;
    conn.loadOlder(first);
  });
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      unread = 0;
      document.title = baseTitle;
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  async function confirmLeave() {
    const ok = await dialog({
      title: 'Ieși din cameră?',
      body: [h('p', null, 'Pe acest dispozitiv vei avea nevoie din nou de cod și parolă pentru a reintra. Mesajele rămân în arhivă.')],
      confirmLabel: 'Ieși',
      danger: true,
    });
    if (!ok) return;
    conn.stop();
    try {
      await leaveRoom(session!);
    } catch {
      // sesiunea locală este ștearsă oricum
    }
    navigate('/');
  }

  render('bottom');
  renderPeople();
  if (opts.asAdmin) {
    adminToken().then(
      () => conn.start(),
      (err) => {
        if (err instanceof NotEnrolledError) navigate('/admin');
        else {
          toast(err instanceof Error ? err.message : 'Eroare.', 'error');
          conn.start();
        }
      },
    );
  } else {
    conn.start();
  }

  return () => {
    conn.stop();
    document.removeEventListener('visibilitychange', onVisible);
    document.title = baseTitle;
  };
}

/** Transformă adresele web din text în link-uri, fără a interpreta niciun HTML. */
function linkify(text: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0]));
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
