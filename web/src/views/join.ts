import { request, type JoinResponse } from '../api.ts';
import { h } from '../dom.ts';
import { navigate } from '../nav.ts';
import { lastDisplayName, listRoomSessions, saveRoomSession } from '../sessions.ts';
import { busy, field } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

export function renderJoin(root: HTMLElement, params: Record<string, string>): void {
  const code = (params.code ?? '').toLowerCase();
  const already = listRoomSessions().find((s) => s.roomCode === code);
  if (already) {
    navigate(`/room/${already.roomId}`);
    return;
  }

  const codeInput = h('input', { name: 'code', required: true, value: code, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const pwInput = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const nameInput = h('input', { name: 'displayName', required: true, maxlength: 40, value: lastDisplayName(), autocomplete: 'nickname' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Intră în cameră');

  const doJoin = busy(
    submit,
    async () => {
      const res = await request<JoinResponse>('POST', '/api/rooms/join', {
        body: { code: codeInput.value.trim().toLowerCase(), password: pwInput.value, displayName: nameInput.value },
      });
      const session = saveRoomSession(res);
      navigate(`/room/${session.roomId}`);
    },
    error,
  );

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        void doJoin();
      },
    },
    field('Codul camerei', codeInput),
    field('Parola camerei', pwInput, 'Parola ți-a fost transmisă de administrator, separat de link.'),
    field('Numele tău', nameInput, 'Așa te vor vedea ceilalți lângă mesajele tale.'),
    error,
    submit,
  );

  root.append(appBar({ title: 'Intră în cameră', back: '/' }), page(card(form)));
  (code ? pwInput : codeInput).focus();
}
