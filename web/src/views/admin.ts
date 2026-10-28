import {
  adminRequest,
  adminToken,
  cryptoAvailable,
  enrollThisDevice,
  forgetLocalDevice,
  getLocalDevice,
  NotEnrolledError,
} from '../adminAuth.ts';
import { ApiError, errorMessage, type Room } from '../api.ts';
import { backendUrl, roomInviteLink } from '../config.ts';
import { clear, h, icon } from '../dom.ts';
import { navigate } from '../nav.ts';
import { busy, copyText, dialog, field, formatBytes, formatDateTime, toast } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

const TABS = [
  ['camere', 'Camere'],
  ['dispozitive', 'Dispozitive'],
  ['jurnal', 'Jurnal'],
  ['stare', 'Stare și arhivă'],
] as const;
type Tab = (typeof TABS)[number][0];

export function renderAdmin(root: HTMLElement, params: Record<string, string>): void {
  const tab: Tab = (TABS.find(([id]) => id === params.tab)?.[0] ?? 'camere') as Tab;
  const body = page(h('p', { class: 'muted' }, 'Se verifică identitatea dispozitivului…'));
  root.append(appBar({ title: 'Administrare', back: '/' }), body);

  adminToken().then(
    () => {
      clear(body);
      body.append(
        h(
          'nav',
          { class: 'tabs', 'aria-label': 'Secțiuni administrare' },
          TABS.map(([id, label]) => h('a', { href: `#/admin/${id}`, class: id === tab ? 'tab tab-active' : 'tab', 'aria-current': id === tab ? 'page' : null }, label)),
        ),
      );
      const content = h('div', { class: 'tab-content' });
      body.append(content);
      const views: Record<Tab, (el: HTMLElement) => Promise<void>> = {
        camere: roomsTab,
        dispozitive: devicesTab,
        jurnal: auditTab,
        stare: statusTab,
      };
      views[tab](content).catch((err) => content.append(errorCard(err)));
    },
    async (err) => {
      clear(body);
      if (err instanceof NotEnrolledError) return body.append(setupCard());
      if (err instanceof ApiError && err.status === 401) return body.append(await revokedCard());
      body.append(errorCard(err));
    },
  );
}

function errorCard(err: unknown): HTMLElement {
  return card(h('h2', null, 'Nu se poate încărca'), h('p', { class: 'form-error' }, errorMessage(err)), h('button', { class: 'btn', onclick: () => location.reload() }, 'Reîncearcă'));
}

// ---- înrolare dispozitiv ----

function setupCard(): HTMLElement {
  const codeInput = h('input', { name: 'code', required: true, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' });
  const labelInput = h('input', { name: 'label', required: true, maxlength: 60, value: guessDeviceLabel() });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Înregistrează acest dispozitiv');
  const run = busy(
    submit,
    async () => {
      await enrollThisDevice(codeInput.value, labelInput.value);
      await adminToken();
      toast('Dispozitiv înregistrat ca administrator.', 'ok');
      navigate('/admin');
    },
    error,
  );
  return card(
    h('h2', null, 'Înregistrează acest dispozitiv ca administrator'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Prima dată: codul de inițializare apare în fereastra serverului de pe laptop.'),
      h('li', null, 'Pentru telefon: pe laptop, deschide Administrare → Dispozitive → „Adaugă dispozitiv” și folosește codul afișat.'),
      h('li', null, 'Acest browser își creează o cheie secretă care nu părăsește niciodată dispozitivul.'),
    ),
    cryptoAvailable()
      ? h(
          'form',
          { class: 'stack', onsubmit: (ev: Event) => (ev.preventDefault(), void run()) },
          field('Cod de înrolare', codeInput),
          field('Numele dispozitivului', labelInput, 'Ex. „Laptop” sau „Telefon Adrian”. Îl vei vedea în lista de dispozitive.'),
          error,
          submit,
        )
      : h('p', { class: 'form-error' }, 'Acest browser nu permite criptografia necesară aici. Deschide pagina prin https:// (sau de pe laptop, prin localhost).'),
    h('p', { class: 'muted small' }, `Server: ${backendUrl()}`),
  );
}

async function revokedCard(): Promise<HTMLElement> {
  const device = await getLocalDevice();
  const btn = h('button', { class: 'btn btn-danger' }, 'Șterge cheia locală');
  btn.addEventListener(
    'click',
    busy(btn, async () => {
      await forgetLocalDevice();
      navigate('/admin');
    }),
  );
  return card(
    h('h2', null, 'Dispozitiv neautorizat'),
    h('p', null, `Dispozitivul „${device?.label ?? ''}” a fost revocat sau nu mai este recunoscut de server. Șterge cheia locală și înregistrează-l din nou cu un cod nou.`),
    btn,
  );
}

function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Telefon Android';
  if (/Windows/.test(ua)) return 'Laptop Windows';
  return 'Dispozitiv';
}

// ---- camere ----

async function roomsTab(el: HTMLElement): Promise<void> {
  const { rooms } = await adminRequest<{ rooms: Room[] }>('GET', '/api/admin/rooms');

  const nameInput = h('input', { name: 'name', required: true, maxlength: 60, placeholder: 'ex. Familia' });
  const pwInput = h('input', { name: 'password', type: 'text', required: true, minlength: 8, maxlength: 128, autocomplete: 'off', spellcheck: 'false', value: suggestPassword() });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Creează camera');
  const create = busy(
    submit,
    async () => {
      const { room } = await adminRequest<{ room: Room }>('POST', '/api/admin/rooms', { name: nameInput.value, password: pwInput.value });
      await showCreated(room, pwInput.value);
      navigate('/admin/camere');
    },
    error,
  );

  el.append(
    card(
      h('h2', null, 'Cameră nouă'),
      h(
        'form',
        { class: 'stack', 'data-testid': 'create-room', onsubmit: (ev: Event) => (ev.preventDefault(), void create()) },
        field('Numele camerei', nameInput),
        field('Parola camerei', pwInput, 'Minim 8 caractere. O frază lungă e mai sigură. Trimite parola separat de link.'),
        error,
        submit,
      ),
    ),
    card(
      h('h2', null, `Camere (${rooms.length})`),
      rooms.length === 0 ? h('p', { class: 'muted' }, 'Nu există camere încă.') : h('ul', { class: 'admin-rooms' }, rooms.map(roomRow)),
    ),
  );
}

async function showCreated(room: Room, password: string): Promise<void> {
  const link = roomInviteLink(room.code);
  await dialog({
    title: `Camera „${room.name}” a fost creată`,
    body: [
      h('p', null, 'Trimite participanților link-ul și, separat, parola:'),
      h('div', { class: 'copy-row' }, h('code', { 'data-testid': 'invite-link' }, link), h('button', { type: 'button', class: 'btn btn-small', onclick: () => void copyText(link, 'Link-ul') }, 'Copiază')),
      h('div', { class: 'copy-row' }, h('code', null, password), h('button', { type: 'button', class: 'btn btn-small', onclick: () => void copyText(password, 'Parola') }, 'Copiază')),
      h('p', { class: 'muted small' }, 'Parola nu poate fi afișată din nou (serverul păstrează doar o amprentă a ei). O poți schimba oricând.'),
    ],
    confirmLabel: 'Gata',
  });
}

function roomRow(room: Room): HTMLElement {
  const closed = room.closedAt !== null;
  const participants = h('div', { class: 'participants', hidden: true });
  const toggleParticipants = async () => {
    if (!participants.hidden) {
      participants.hidden = true;
      return;
    }
    participants.hidden = false;
    clear(participants);
    participants.append(h('p', { class: 'muted small' }, 'Se încarcă…'));
    try {
      await loadParticipants(room, participants);
    } catch (err) {
      clear(participants);
      participants.append(h('p', { class: 'form-error' }, errorMessage(err)));
    }
  };
  return h(
    'li',
    { class: 'admin-room', 'data-testid': 'admin-room', 'data-code': room.code },
    h(
      'div',
      { class: 'admin-room-head' },
      h('div', null, h('strong', null, room.name), closed ? h('span', { class: 'badge badge-muted' }, 'închisă') : null, h('div', { class: 'muted small' }, `cod ${room.code} · creată ${formatDateTime(room.createdAt)} · max. ${room.maxParticipants}`)),
    ),
    h(
      'div',
      { class: 'button-row' },
      h('a', { class: 'btn btn-small btn-primary', href: `#/admin/room/${room.id}` }, 'Deschide chat'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => void copyText(roomInviteLink(room.code), 'Link-ul') }, icon('copy'), 'Link'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => void toggleParticipants() }, icon('people'), 'Participanți'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => void editRoom(room) }, 'Setări'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => void toggleClosed(room) }, closed ? 'Redeschide' : 'Închide'),
      h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: () => void removeRoom(room) }, 'Șterge'),
    ),
    participants,
  );
}

async function loadParticipants(room: Room, el: HTMLElement): Promise<void> {
  const { participants } = await adminRequest<{
    participants: { id: string; displayName: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null }[];
  }>('GET', `/api/admin/rooms/${room.id}/participants`);
  clear(el);
  if (participants.length === 0) {
    el.append(h('p', { class: 'muted small' }, 'Nimeni nu a intrat încă.'));
    return;
  }
  el.append(
    h(
      'ul',
      { class: 'participant-rows' },
      participants.map((p) => {
        const revoke = h('button', { class: 'btn btn-small btn-danger', type: 'button' }, 'Revocă accesul');
        revoke.addEventListener(
          'click',
          busy(revoke, async () => {
            const ok = await dialog({
              title: `Revoci accesul pentru „${p.displayName}”?`,
              body: [h('p', null, 'Persoana este deconectată imediat. Pentru a reveni, ar avea nevoie din nou de parola camerei; schimb-o dacă vrei să o oprești definitiv.')],
              confirmLabel: 'Revocă',
              danger: true,
            });
            if (!ok) return;
            await adminRequest('POST', `/api/admin/participants/${p.id}/revoke`);
            toast(`Acces revocat pentru ${p.displayName}.`, 'ok');
            await loadParticipants(room, el);
          }),
        );
        return h(
          'li',
          { 'data-testid': 'participant-row' },
          h('div', null, h('strong', null, p.displayName), h('div', { class: 'muted small' }, `intrat ${formatDateTime(p.createdAt)}${p.lastSeenAt ? ` · văzut ${formatDateTime(p.lastSeenAt)}` : ''}`)),
          p.revokedAt ? h('span', { class: 'badge badge-muted' }, 'revocat') : revoke,
        );
      }),
    ),
  );
}

async function editRoom(room: Room): Promise<void> {
  const data = await dialog({
    title: `Setări „${room.name}”`,
    body: [
      field('Nume', h('input', { name: 'name', required: true, maxlength: 60, value: room.name })),
      field('Parolă nouă', h('input', { name: 'password', type: 'text', minlength: 8, maxlength: 128, autocomplete: 'off', placeholder: 'lasă gol pentru a o păstra' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'revokeSessions' }), 'Deconectează pe toți cei care au intrat cu parola veche'),
      field('Număr maxim de participanți', h('input', { name: 'maxParticipants', type: 'number', min: 2, max: 500, required: true, value: room.maxParticipants })),
    ],
    confirmLabel: 'Salvează',
  });
  if (!data) return;
  const password = String(data.get('password') ?? '');
  try {
    await adminRequest('PATCH', `/api/admin/rooms/${room.id}`, {
      name: String(data.get('name')),
      maxParticipants: Number(data.get('maxParticipants')),
      ...(password ? { password, revokeSessions: data.get('revokeSessions') === 'on' } : {}),
    });
    toast('Setările camerei au fost salvate.', 'ok');
    navigate('/admin/camere');
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

async function toggleClosed(room: Room): Promise<void> {
  const closing = room.closedAt === null;
  if (closing) {
    const ok = await dialog({
      title: `Închizi camera „${room.name}”?`,
      body: [h('p', null, 'Toți participanții sunt deconectați și nimeni nu mai poate intra. Mesajele rămân în arhivă. O poți redeschide oricând.')],
      confirmLabel: 'Închide camera',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await adminRequest('PATCH', `/api/admin/rooms/${room.id}`, { closed: closing });
    toast(closing ? 'Camera a fost închisă.' : 'Camera a fost redeschisă.', 'ok');
    navigate('/admin/camere');
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

async function removeRoom(room: Room): Promise<void> {
  const data = await dialog({
    title: `Ștergi definitiv camera „${room.name}”?`,
    body: [
      h('p', null, 'Se șterg camera, toate mesajele și participanții ei. Operațiunea nu poate fi anulată.'),
      field(`Scrie codul camerei (${room.code}) pentru confirmare`, h('input', { name: 'confirm', required: true, autocomplete: 'off', autocapitalize: 'none' })),
    ],
    confirmLabel: 'Șterge definitiv',
    danger: true,
    validate: (d) => (String(d.get('confirm')).trim().toLowerCase() === room.code ? null : 'Codul nu corespunde.'),
  });
  if (!data) return;
  try {
    await adminRequest('DELETE', `/api/admin/rooms/${room.id}`, { confirmCode: room.code });
    toast('Camera a fost ștearsă.', 'ok');
    navigate('/admin/camere');
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

function suggestPassword(): string {
  // 4 grupuri de câte 4 caractere ușor de dictat: ~80 biți.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

// ---- dispozitive ----

interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastLoginAt: number | null;
  revokedAt: number | null;
}

async function devicesTab(el: HTMLElement): Promise<void> {
  const [{ devices }, local] = await Promise.all([adminRequest<{ devices: Device[] }>('GET', '/api/admin/devices'), getLocalDevice()]);
  const addBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('plus'), 'Adaugă dispozitiv');
  addBtn.addEventListener(
    'click',
    busy(addBtn, async () => {
      const { code, expiresAt } = await adminRequest<{ code: string; expiresAt: number }>('POST', '/api/admin/enrollment-codes');
      await dialog({
        title: 'Cod pentru dispozitivul nou',
        body: [
          h('p', null, 'Pe telefon, deschide NEXUS CHAT → Administrare și introdu codul:'),
          h('p', { class: 'big-code', 'data-testid': 'enrollment-code' }, code),
          h('p', { class: 'muted small' }, `Valabil până la ${formatDateTime(expiresAt)}, o singură dată. Nu-l trimite prin mesaje; introdu-l direct.`),
        ],
        confirmLabel: 'Gata',
      });
    }),
  );
  el.append(
    card(
      h('h2', null, 'Dispozitive de administrator'),
      h('p', { class: 'muted' }, 'Fiecare dispozitiv are propria cheie. Revocă imediat un telefon pierdut.'),
      addBtn,
      h(
        'ul',
        { class: 'device-list' },
        devices.map((d) => {
          const isThis = local?.deviceId === d.id;
          const revoke = h('button', { class: 'btn btn-small btn-danger', type: 'button' }, 'Revocă');
          revoke.addEventListener(
            'click',
            busy(revoke, async () => {
              const ok = await dialog({
                title: `Revoci dispozitivul „${d.label}”?`,
                body: [
                  h('p', null, isThis ? 'Este chiar dispozitivul pe care îl folosești acum: vei pierde accesul de administrator de aici.' : 'Dispozitivul pierde imediat accesul de administrator.'),
                ],
                confirmLabel: 'Revocă',
                danger: true,
              });
              if (!ok) return;
              await adminRequest('POST', `/api/admin/devices/${d.id}/revoke`);
              toast('Dispozitiv revocat.', 'ok');
              if (isThis) await forgetLocalDevice();
              navigate(isThis ? '/admin' : '/admin/dispozitive');
            }),
          );
          return h(
            'li',
            null,
            h(
              'div',
              null,
              h('strong', null, d.label),
              isThis ? h('span', { class: 'badge' }, 'acesta') : null,
              h('div', { class: 'muted small' }, `înregistrat ${formatDateTime(d.createdAt)}${d.lastLoginAt ? ` · ultima autentificare ${formatDateTime(d.lastLoginAt)}` : ''}`),
            ),
            d.revokedAt ? h('span', { class: 'badge badge-muted' }, 'revocat') : revoke,
          );
        }),
      ),
    ),
  );
}

// ---- jurnal ----

const ACTIONS: Record<string, string> = {
  'admin.enrollment_code_issued': 'Cod de înrolare emis',
  'admin.device_enrolled': 'Dispozitiv înregistrat',
  'admin.login': 'Autentificare administrator',
  'admin.login_failed': 'Autentificare eșuată',
  'admin.device_revoked': 'Dispozitiv revocat',
  'room.created': 'Cameră creată',
  'room.updated': 'Cameră modificată',
  'room.deleted': 'Cameră ștearsă',
  'participant.revoked': 'Participant revocat',
};

async function auditTab(el: HTMLElement): Promise<void> {
  const { entries } = await adminRequest<{ entries: { id: number; at: number; actor: string; action: string; detail: string | null }[] }>(
    'GET',
    '/api/admin/audit?limit=200',
  );
  el.append(
    card(
      h('h2', null, 'Jurnal administrativ'),
      h('p', { class: 'muted small' }, 'Ultimele 200 de operațiuni. Jurnalul nu conține parole, tokenuri sau conținutul mesajelor.'),
      h(
        'ul',
        { class: 'audit-list' },
        entries.map((e) => h('li', null, h('time', null, formatDateTime(e.at)), h('span', null, ACTIONS[e.action] ?? e.action), e.detail ? h('code', { class: 'small' }, e.detail) : null)),
      ),
    ),
  );
}

// ---- stare ----

async function statusTab(el: HTMLElement): Promise<void> {
  const s = await adminRequest<{
    version: string;
    uptimeSec: number;
    dataDir: string;
    dbSizeBytes: number;
    diskFreeBytes: number | null;
    rooms: number;
    messages: number;
    files: number;
    filesBytes: number;
    wsConnections: number;
  }>('GET', '/api/admin/status');
  const a = await adminRequest<ArchiveInfo>('GET', '/api/admin/archive');
  el.append(
    card(
      h('h2', null, 'Starea serverului'),
      h(
        'dl',
        { class: 'kv-list' },
        kv('Versiune', s.version),
        kv('Pornit de', formatUptime(s.uptimeSec)),
        kv('Conexiuni active', String(s.wsConnections)),
        kv('Camere', String(s.rooms)),
        kv('Mesaje arhivate', String(s.messages)),
        kv('Fișiere', `${s.files} (${formatBytes(s.filesBytes)})`),
        kv('Dimensiune bază de date', formatBytes(s.dbSizeBytes)),
        kv('Spațiu liber pe disc', formatBytes(s.diskFreeBytes)),
        kv('Limită per fișier', formatBytes(a.maxFileBytes)),
        kv('Folderul arhivei', s.dataDir),
        kv('Adresa serverului', backendUrl()),
      ),
    ),
    backupCard(a),
    retentionCard(a),
    integrityCard(),
    restoreCard(a),
  );
}

interface ArchiveInfo {
  settings: { retentionDays: number | null; backup: { enabled: boolean; intervalHours: number; keep: number; dir: string | null } };
  backupDir: string;
  defaultBackupDir: string;
  backups: { name: string; createdAt: number; dbSize: number; fileCount: number; fileBytes: number }[];
  backupStatus: { lastAttemptAt: number | null; lastSuccessAt: number | null; lastSuccessName: string | null; lastError: string | null };
  dataFreeBytes: number | null;
  backupFreeBytes: number | null;
  maxFileBytes: number;
}

const kv = (k: string, v: string) => h('div', { class: 'kv' }, h('dt', null, k), h('dd', null, v));

function backupCard(a: ArchiveInfo): HTMLElement {
  const st = a.backupStatus;
  const nowBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Fă backup acum');
  nowBtn.addEventListener(
    'click',
    busy(nowBtn, async () => {
      nowBtn.textContent = 'Se face backup…';
      try {
        const { backup } = await adminRequest<{ backup: { name: string; fileCount: number } }>('POST', '/api/admin/archive/backups');
        toast(`Backup creat și verificat (${backup.fileCount} fișiere).`, 'ok');
        navigate('/admin/stare');
      } finally {
        nowBtn.textContent = 'Fă backup acum';
      }
    }),
  );
  const settingsBtn = h('button', { class: 'btn', type: 'button', onclick: () => void editBackupSettings(a) }, 'Setări backup');
  const sameDisk = a.settings.backup.dir === null;
  return card(
    h('h2', null, 'Backup'),
    h(
      'dl',
      { class: 'kv-list' },
      kv('Backup automat', a.settings.backup.enabled ? `da, la fiecare ${a.settings.backup.intervalHours} h` : 'oprit'),
      kv('Copii păstrate', String(a.settings.backup.keep)),
      kv('Folder', a.backupDir),
      kv('Spațiu liber acolo', formatBytes(a.backupFreeBytes)),
      kv('Ultimul backup reușit', st.lastSuccessAt ? formatDateTime(st.lastSuccessAt) : 'niciunul încă'),
    ),
    st.lastError && st.lastAttemptAt !== st.lastSuccessAt
      ? h('p', { class: 'form-error', role: 'alert' }, `Ultima încercare (${formatDateTime(st.lastAttemptAt!)}) a eșuat: ${st.lastError}`)
      : null,
    sameDisk
      ? h('p', { class: 'note-warn' }, 'Backup-ul este pe același disc cu arhiva: te protejează de ștergeri accidentale și corupere, dar nu de defectarea discului sau pierderea laptopului. Alege un disc extern în „Setări backup”.')
      : null,
    h('div', { class: 'button-row' }, nowBtn, settingsBtn),
    a.backups.length === 0
      ? h('p', { class: 'muted' }, 'Nu există încă niciun backup.')
      : h(
          'ul',
          { class: 'backup-list', 'data-testid': 'backup-list' },
          a.backups.map((b) => {
            const verify = h('button', { class: 'btn btn-small', type: 'button' }, 'Verifică');
            verify.addEventListener(
              'click',
              busy(verify, async () => {
                const r = await adminRequest<{ ok: boolean; problems: string[] }>('POST', `/api/admin/archive/backups/${b.name}/verify`);
                if (r.ok) toast('Backup verificat: toate amprentele SHA-256 corespund.', 'ok');
                else toast(`Backup deteriorat: ${r.problems.slice(0, 3).join('; ')}`, 'error');
              }),
            );
            return h(
              'li',
              { 'data-testid': 'backup-row' },
              h('div', null, h('strong', null, formatDateTime(b.createdAt)), h('div', { class: 'muted small' }, `${b.name} · ${b.fileCount} fișiere · ${formatBytes(b.dbSize + b.fileBytes)}`)),
              verify,
            );
          }),
        ),
  );
}

async function editBackupSettings(a: ArchiveInfo): Promise<void> {
  const b = a.settings.backup;
  const data = await dialog({
    title: 'Setări backup',
    body: [
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: b.enabled }), 'Backup automat'),
      field('Interval (ore)', h('input', { name: 'intervalHours', type: 'number', min: 1, max: 720, required: true, value: b.intervalHours })),
      field('Câte copii se păstrează', h('input', { name: 'keep', type: 'number', min: 1, max: 100, required: true, value: b.keep })),
      field(
        'Folder pentru backup',
        h('input', { name: 'dir', value: b.dir ?? '', placeholder: a.defaultBackupDir, spellcheck: 'false' }),
        'Cale completă pe laptop, ideal pe un disc extern (ex. E:\\NexusBackup). Gol = folderul implicit.',
      ),
    ],
    confirmLabel: 'Salvează',
  });
  if (!data) return;
  try {
    await adminRequest('PUT', '/api/admin/archive/settings', {
      backup: {
        enabled: data.get('enabled') === 'on',
        intervalHours: Number(data.get('intervalHours')),
        keep: Number(data.get('keep')),
        dir: String(data.get('dir') ?? '').trim() || null,
      },
    });
    toast('Setările de backup au fost salvate.', 'ok');
    navigate('/admin/stare');
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

const RETENTION_CHOICES: [number | null, string][] = [
  [null, 'Pentru totdeauna'],
  [365, '1 an'],
  [180, '6 luni'],
  [90, '3 luni'],
  [30, '30 de zile'],
];

function retentionCard(a: ArchiveInfo): HTMLElement {
  const current = a.settings.retentionDays;
  const select = h(
    'select',
    { name: 'retention', 'aria-label': 'Cât timp se păstrează mesajele' },
    RETENTION_CHOICES.map(([days, label]) => h('option', { value: days === null ? '' : String(days), selected: days === current }, label)),
  );
  if (current !== null && !RETENTION_CHOICES.some(([d]) => d === current)) {
    select.append(h('option', { value: String(current), selected: true }, `${current} zile`));
  }
  const save = h('button', { class: 'btn', type: 'button' }, 'Aplică');
  save.addEventListener(
    'click',
    busy(save, async () => {
      const days = select.value === '' ? null : Number(select.value);
      if (days !== null) {
        const p = await adminRequest<{ messages: number; files: number; fileBytes: number }>('GET', `/api/admin/archive/retention-preview?days=${days}`);
        const ok = await dialog({
          title: 'Ștergi istoricul vechi?',
          body: [
            h('p', null, `Se vor șterge definitiv ${p.messages} mesaje și ${p.files} fișiere (${formatBytes(p.fileBytes)}) mai vechi de ${days} zile.`),
            h('p', null, 'De acum înainte, ce depășește această vârstă va fi șters automat. Backup-urile existente nu sunt afectate.'),
          ],
          confirmLabel: 'Aplică și șterge',
          danger: true,
        });
        if (!ok) return;
      }
      const res = await adminRequest<{ retentionApplied: { messages: number } }>('PUT', '/api/admin/archive/settings', { retentionDays: days });
      toast(days === null ? 'Mesajele se păstrează pentru totdeauna.' : `Politică aplicată: ${res.retentionApplied.messages} mesaje șterse.`, 'ok');
      navigate('/admin/stare');
    }),
  );
  return card(
    h('h2', null, 'Păstrarea istoricului'),
    h('p', { class: 'muted' }, 'Mesajele și fișierele mai vechi decât perioada aleasă sunt șterse automat. Apelurile nu sunt înregistrate niciodată.'),
    h('div', { class: 'inline-form' }, select, save),
  );
}

function integrityCard(): HTMLElement {
  const out = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { class: 'btn', type: 'button' }, 'Verifică integritatea arhivei');
  btn.addEventListener(
    'click',
    busy(btn, async () => {
      clear(out);
      const r = await adminRequest<{ ok: boolean; database: { ok: boolean; details: string[] }; files: { checked: number; missing: string[]; corrupted: string[] } }>(
        'POST',
        '/api/admin/archive/verify',
      );
      out.append(
        h(
          'p',
          { class: r.ok ? 'note-ok' : 'form-error', 'data-testid': 'integrity-result' },
          r.ok
            ? `Totul este în regulă: baza de date și ${r.files.checked} fișiere verificate (SHA-256).`
            : `Probleme: ${[!r.database.ok ? 'baza de date' : '', r.files.missing.length ? `${r.files.missing.length} fișiere lipsă` : '', r.files.corrupted.length ? `${r.files.corrupted.length} fișiere corupte` : ''].filter(Boolean).join(', ')}. Restaurează din backup.`,
        ),
      );
    }),
  );
  return card(h('h2', null, 'Integritate'), h('p', { class: 'muted' }, 'Recalculează amprentele tuturor fișierelor și verifică baza de date.'), btn, out);
}

function restoreCard(a: ArchiveInfo): HTMLElement {
  return card(
    h('h2', null, 'Restaurare'),
    h('p', null, 'Restaurarea înlocuiește arhiva, deci se face cu serverul oprit, pe laptop:'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Oprește serverul (Ctrl+C în fereastra lui).'),
      h('li', null, 'Listează backup-urile: ', h('code', null, 'npm run backup -- --list')),
      h('li', null, 'Restaurează: ', h('code', null, `npm run restore -- ${a.backups[0]?.name ?? 'nexus-AAAALLZZ-…'}`)),
      h('li', null, 'Pornește serverul din nou.'),
    ),
    h('p', { class: 'muted small' }, 'Arhiva curentă nu este ștearsă: este redenumită „…inainte-de-restaurare-…”. Backup-ul este verificat complet înainte de restaurare. În aplicația Windows (M6) va exista un buton.'),
  );
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d} z ${hrs} h` : hrs > 0 ? `${hrs} h ${min} min` : `${min} min`;
}
