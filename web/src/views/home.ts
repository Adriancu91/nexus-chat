import { h, icon } from '../dom.ts';
import { navigate } from '../nav.ts';
import { listRoomSessions } from '../sessions.ts';
import { initials, senderHue } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

export function renderHome(root: HTMLElement): void {
  const sessions = listRoomSessions();
  const codeInput = h('input', {
    name: 'code',
    required: true,
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'ex. k7m2p9q4xa sau link-ul primit',
    'aria-label': 'Codul sau link-ul camerei',
  });
  const form = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        navigate(`/join/${encodeURIComponent(extractCode(codeInput.value))}`);
      },
    },
    codeInput,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Continuă'),
  );

  root.append(
    appBar({
      title: 'NEXUS CHAT',
      actions: [
        h('a', { class: 'icon-btn', href: '#/admin', 'aria-label': 'Administrare', title: 'Administrare' }, icon('shield')),
        h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': 'Setări', title: 'Setări' }, icon('settings')),
      ],
    }),
    page(
      sessions.length > 0
        ? card(
            h('h2', null, 'Camerele mele'),
            h(
              'ul',
              { class: 'room-list' },
              sessions.map((s) =>
                h(
                  'li',
                  null,
                  h(
                    'a',
                    { class: 'room-item', href: `#/room/${s.roomId}` },
                    h('span', { class: 'avatar', style: { '--hue': senderHue(s.roomId) } }, initials(s.roomName)),
                    h('span', { class: 'room-item-text' }, h('strong', null, s.roomName), h('small', null, `ca ${s.displayName}`)),
                  ),
                ),
              ),
            ),
          )
        : null,
      card(h('h2', null, 'Intră într-o cameră'), h('p', { class: 'muted' }, 'Introdu codul sau link-ul primit de la administrator.'), form),
    ),
  );
}

/** Acceptă fie codul, fie link-ul complet de invitație. */
export function extractCode(input: string): string {
  const v = input.trim();
  const m = /#\/join\/([^/?#\s]+)/.exec(v);
  return (m ? decodeURIComponent(m[1]!) : v).toLowerCase();
}
