import { adminToken, clearAdminSession, NotEnrolledError } from '../adminAuth.ts';
import { errorMessage, request, type Message } from '../api.ts';
import { clear, h, icon } from '../dom.ts';
import { PreviewCache, saveFile, uploadFile, type UploadHandle } from '../files.ts';
import { navigate } from '../nav.ts';
import { RoomConnection, type ConnectionState, type PendingMessage, type PresenceEntry } from '../realtime.ts';
import { forgetRoomSession, getRoomSession, leaveRoom } from '../sessions.ts';
import { dayLabel, dialog, formatBytes, formatDateTime, formatTime, iconButton, initials, senderHue, toast } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

const MAX_CHARS = 4000;
const GROUP_GAP_MS = 5 * 60_000;
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
const MAX_JUMP_PAGES = 30;

type PanelMode = 'people' | 'files' | 'search';

interface ActiveUpload {
  id: string;
  file: File;
  progress: number;
  handle: UploadHandle;
}

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
  const token = opts.asAdmin ? adminToken : async () => session!.token;
  const messages = new Map<string, Message>();
  const uploads = new Map<string, ActiveUpload>();
  const previews = new PreviewCache();
  let pending: PendingMessage[] = [];
  let online: PresenceEntry[] = [];
  let hasOlder = false;
  let loadingOlder = false;
  let roomClosed = false;
  let unread = 0;
  let panelMode: PanelMode | null = null;
  let jumpTarget: { seq: number; pages: number } | null = null;
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
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'data-testid': 'file-input' });
  const attachBtn = iconButton('attach', 'Atașează fișier', () => fileInput.click(), 'attach-btn');
  const sendBtn = h('button', { class: 'send-btn', type: 'submit', 'aria-label': 'Trimite', title: 'Trimite' }, icon('send'));
  const composer = h('form', { class: 'composer' }, attachBtn, fileInput, h('div', { class: 'composer-input' }, textarea, counter), sendBtn);
  const closedNote = h('div', { class: 'closed-note', hidden: true }, 'Camera este închisă. Nu se mai pot trimite mesaje.');
  const panelTitle = h('h2', null);
  const panelBody = h('div', { class: 'side-body' });
  const panel = h(
    'aside',
    { class: 'side-panel', hidden: true, 'aria-labelledby': 'side-title' },
    h('div', { class: 'side-head' }, panelTitle, iconButton('close', 'Închide panoul', () => openPanel(null))),
    panelBody,
  );
  panelTitle.id = 'side-title';
  const main = h('main', { class: 'chat-main' }, scroller, closedNote, composer);

  const actions = [
    iconButton('search', 'Caută în conversație', () => openPanel(panelMode === 'search' ? null : 'search')),
    iconButton('folder', 'Fișiere', () => openPanel(panelMode === 'files' ? null : 'files')),
    iconButton('people', 'Participanți', () => openPanel(panelMode === 'people' ? null : 'people')),
  ];
  if (!opts.asAdmin) actions.push(iconButton('logout', 'Ieși din cameră', () => void confirmLeave()));

  root.append(
    h(
      'div',
      { class: 'chat' },
      appBar({ title: h('span', { class: 'title-with-avatar' }, roomAvatar, title), subtitle, back: opts.asAdmin ? '/admin' : '/', actions }),
      banner,
      h('div', { class: 'chat-body' }, main, panel),
    ),
  );

  // ---- panou lateral: participanți / fișiere / căutare ----
  function openPanel(mode: PanelMode | null) {
    panelMode = mode;
    panel.hidden = mode === null;
    clear(panelBody);
    if (mode === 'people') {
      panelTitle.textContent = 'Participanți online';
      renderPeople();
    } else if (mode === 'files') {
      panelTitle.textContent = 'Fișiere';
      void renderFiles();
    } else if (mode === 'search') {
      panelTitle.textContent = 'Caută în conversație';
      renderSearch();
    }
  }

  function renderPeople() {
    if (panelMode !== 'people') return;
    clear(panelBody);
    const ul = h('ul', { class: 'people-list', 'data-testid': 'people-list' });
    for (const p of online) {
      ul.append(
        h(
          'li',
          null,
          h('span', { class: 'avatar avatar-sm', style: { '--hue': senderHue(p.senderId) } }, initials(p.displayName)),
          h('span', null, p.displayName, p.senderId === mySenderId ? ' (tu)' : ''),
          p.senderKind === 'admin' ? h('span', { class: 'badge' }, 'admin') : null,
        ),
      );
    }
    if (online.length === 0) ul.append(h('li', { class: 'muted' }, 'Nimeni online.'));
    panelBody.append(ul);
    if (opts.asAdmin) panelBody.append(h('p', { class: 'muted small' }, 'Lista completă și revocarea accesului sunt în panoul de administrare.'));
  }

  async function renderFiles() {
    panelBody.append(h('p', { class: 'muted small' }, 'Se încarcă…'));
    try {
      const res = await request<{ messages: Message[] }>('GET', `/api/rooms/${opts.roomId}/files?limit=200`, { token: await token() });
      if (panelMode !== 'files') return;
      clear(panelBody);
      if (res.messages.length === 0) {
        panelBody.append(h('p', { class: 'muted' }, 'Niciun fișier trimis încă.'));
        return;
      }
      panelBody.append(
        h(
          'ul',
          { class: 'file-list', 'data-testid': 'file-list' },
          res.messages.map((m) =>
            h(
              'li',
              null,
              fileCard(m, false),
              h('div', { class: 'muted small' }, `${m.senderName} · ${formatDateTime(m.createdAt)}`),
            ),
          ),
        ),
      );
    } catch (err) {
      clear(panelBody);
      panelBody.append(h('p', { class: 'form-error' }, errorMessage(err)));
    }
  }

  function renderSearch() {
    const input = h('input', { type: 'search', placeholder: 'Cuvinte sau nume de fișier', 'aria-label': 'Text de căutat', enterkeyhint: 'search' });
    const results = h('div', { class: 'search-results', 'aria-live': 'polite', 'data-testid': 'search-results' });
    let timer: number | undefined;
    let seqNo = 0;
    const run = async () => {
      const q = input.value.trim();
      const mine = ++seqNo;
      clear(results);
      if (!q) return;
      results.append(h('p', { class: 'muted small' }, 'Se caută…'));
      try {
        const res = await request<{ results: { message: Message; snippet: string }[] }>(
          'GET',
          `/api/rooms/${opts.roomId}/search?q=${encodeURIComponent(q)}`,
          { token: await token() },
        );
        if (mine !== seqNo) return;
        clear(results);
        if (res.results.length === 0) {
          results.append(h('p', { class: 'muted' }, 'Niciun rezultat.'));
          return;
        }
        results.append(
          h('p', { class: 'muted small' }, res.results.length === 50 ? 'Primele 50 de rezultate:' : `${countRo(res.results.length, 'rezultat', 'rezultate')}:`),
          h(
            'ul',
            { class: 'result-list' },
            res.results.map((r) =>
              h(
                'li',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'result',
                    'data-testid': 'search-result',
                    onclick: () => {
                      if (matchMedia('(max-width: 760px)').matches) openPanel(null);
                      jumpTo(r.message.seq);
                    },
                  },
                  h('span', { class: 'result-meta' }, h('strong', null, r.message.senderName), ` · ${formatDateTime(r.message.createdAt)}`),
                  h('span', { class: 'result-snippet' }, ...highlight(r.snippet)),
                ),
              ),
            ),
          ),
        );
      } catch (err) {
        if (mine !== seqNo) return;
        clear(results);
        results.append(h('p', { class: 'form-error' }, errorMessage(err)));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void run(), 300);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        clearTimeout(timer);
        void run();
      }
    });
    panelBody.append(input, results);
    input.focus();
  }

  /** Derulează la un mesaj; dacă nu e încărcat, încarcă pagini mai vechi până ajunge la el. */
  function jumpTo(seq: number) {
    const el = list.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (el) {
      jumpTarget = null;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('msg-flash');
      void el.offsetWidth;
      el.classList.add('msg-flash');
      return;
    }
    if (!hasOlder) return toast('Mesajul nu mai este în istoric.', 'info');
    jumpTarget = { seq, pages: (jumpTarget?.seq === seq ? jumpTarget.pages : 0) + 1 };
    if (jumpTarget.pages > MAX_JUMP_PAGES) {
      jumpTarget = null;
      return toast('Mesajul este foarte vechi; derulează în sus pentru a-l găsi.', 'info');
    }
    loadOlder();
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
    if (sorted.length === 0 && pending.length === 0 && uploads.size === 0) {
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
    for (const u of uploads.values()) list.append(uploadEl(u));
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
        m.file ? fileCard(m, true) : null,
        m.body ? h('div', { class: 'body' }, ...linkify(m.body)) : null,
        h('div', { class: 'meta' }, h('time', { datetime: new Date(m.createdAt).toISOString(), title: formatDateTime(m.createdAt) }, formatTime(m.createdAt)), own ? icon('check', 'Salvat pe server') : null),
      ),
    );
  }

  function fileCard(m: Message, withPreview: boolean): HTMLElement {
    const f = m.file!;
    const download = async (btn: HTMLButtonElement) => {
      btn.disabled = true;
      try {
        await saveFile(f.id, f.name, await token());
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        btn.disabled = false;
      }
    };
    const dlBtn = h('button', { type: 'button', class: 'icon-btn file-dl', 'aria-label': `Descarcă ${f.name}`, title: 'Descarcă' }, icon('download'));
    dlBtn.addEventListener('click', () => void download(dlBtn));
    let preview: HTMLElement | null = null;
    if (withPreview && f.previewable) {
      const img = h('img', { class: 'thumb', alt: f.name, 'data-testid': 'image-preview' });
      const unavailable = () => img.parentElement?.replaceWith(h('span', { class: 'muted small' }, 'Previzualizare indisponibilă'));
      img.addEventListener('error', unavailable, { once: true });
      previews.get(f.id, token).then((url) => {
        img.src = url;
      }, unavailable);
      preview = h('button', { type: 'button', class: 'thumb-btn', 'aria-label': `Deschide imaginea ${f.name}`, onclick: () => void showImage(f.id, f.name) }, img);
    }
    return h(
      'div',
      { class: 'file-block' },
      preview,
      h(
        'div',
        { class: 'file-card', 'data-testid': 'file-card' },
        h('span', { class: 'file-icon' }, icon('file')),
        h('span', { class: 'file-info' }, h('span', { class: 'file-name' }, f.name), h('span', { class: 'file-size' }, formatBytes(f.size))),
        dlBtn,
      ),
    );
  }

  async function showImage(fileId: string, name: string) {
    const url = await previews.get(fileId, token);
    await dialog({
      title: name,
      body: [h('img', { class: 'lightbox-img', src: url, alt: name })],
      confirmLabel: 'Închide',
    });
  }

  function pendingEl(p: PendingMessage): HTMLElement {
    return h(
      'div',
      { class: 'msg msg-own msg-pending', 'data-testid': 'pending-message' },
      h('div', { class: 'bubble' }, h('div', { class: 'body' }, ...linkify(p.body)), h('div', { class: 'meta' }, formatTime(p.createdAt), icon('clock', 'În așteptare'))),
    );
  }

  function uploadEl(u: ActiveUpload): HTMLElement {
    const pct = Math.round(u.progress * 100);
    return h(
      'div',
      { class: 'msg msg-own msg-pending', 'data-testid': 'upload-progress' },
      h(
        'div',
        { class: 'bubble' },
        h(
          'div',
          { class: 'file-card' },
          h('span', { class: 'file-icon' }, icon('file')),
          h('span', { class: 'file-info' }, h('span', { class: 'file-name' }, u.file.name), h('span', { class: 'file-size' }, `Se încarcă… ${pct}% din ${formatBytes(u.file.size)}`)),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Anulează încărcarea', title: 'Anulează', onclick: () => u.handle.cancel() }, icon('close')),
        ),
        h('progress', { max: 100, value: pct, 'aria-label': `Încărcare ${u.file.name}` }),
      ),
    );
  }

  async function startUploads(files: FileList | File[]) {
    if (roomClosed) return;
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        toast(`„${file.name}” este gol.`, 'error');
        continue;
      }
      let t: string;
      try {
        t = await token();
      } catch (err) {
        toast(errorMessage(err), 'error');
        return;
      }
      const id = crypto.randomUUID();
      const handle = uploadFile(opts.roomId, t, file, (fraction) => {
        const u = uploads.get(id);
        if (!u) return;
        const before = Math.round(u.progress * 20);
        u.progress = fraction;
        if (Math.round(fraction * 20) !== before) render();
      });
      uploads.set(id, { id, file, progress: 0, handle });
      render('bottom');
      handle.promise.then(
        (message) => {
          uploads.delete(id);
          messages.set(message.id, message);
          render('bottom');
        },
        (err) => {
          uploads.delete(id);
          render();
          if ((err as { code?: string }).code !== 'aborted') toast(`„${file.name}”: ${errorMessage(err)}`, 'error');
        },
      );
    }
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
    for (const u of uploads.values()) u.handle.cancel();
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
      reason === 'revoked' ? 'Accesul tău în această cameră a fost revocat sau camera a fost închisă. ' : 'Sesiunea ta a expirat. ',
      h('a', { href: `#/join/${session!.roomCode}` }, 'Intră din nou'),
    );
  }

  // ---- conexiune ----
  const conn = new RoomConnection(
    opts.roomId,
    token,
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
          render('keep');
          if (jumpTarget) jumpTo(jumpTarget.seq);
          return;
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

  function loadOlder() {
    const first = [...messages.values()].reduce((min, m) => Math.min(min, m.seq), Infinity);
    if (loadingOlder || !Number.isFinite(first)) return;
    loadingOlder = true;
    conn.loadOlder(first);
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
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void startUploads(fileInput.files);
    fileInput.value = '';
  });
  main.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('Files')) {
      ev.preventDefault();
      main.classList.add('drop-target');
    }
  });
  main.addEventListener('dragleave', () => main.classList.remove('drop-target'));
  main.addEventListener('drop', (ev) => {
    main.classList.remove('drop-target');
    if (ev.dataTransfer?.files.length) {
      ev.preventDefault();
      void startUploads(ev.dataTransfer.files);
    }
  });
  olderBtn.addEventListener('click', loadOlder);
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
    for (const u of uploads.values()) u.handle.cancel();
    previews.dispose();
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

/** „1 rezultat”, „3 rezultate”, „25 de rezultate” (de la 20 în sus, cu „de”). */
function countRo(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  return n % 100 >= 20 || n % 100 === 0 ? `${n} de ${many}` : `${n} ${many}`;
}

/** Fragmentul de căutare vine cu termenii încadrați de \u0001…\u0002; îi transformăm în <mark>, ca text. */
function highlight(snippet: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  for (const [i, part] of snippet.split(/\u0001|\u0002/).entries()) {
    if (part) out.push(i % 2 === 1 ? h('mark', null, part) : part);
  }
  return out.length ? out : ['(fișier)'];
}
