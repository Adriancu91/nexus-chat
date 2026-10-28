import { request } from '../api.ts';
import { backendOverride, backendUrl, normalizeBackendUrl, setBackendOverride } from '../config.ts';
import { h } from '../dom.ts';
import { busy, field, toast } from '../ui.ts';
import { appBar, card, page } from './layout.ts';

export function renderSettings(root: HTMLElement): void {
  const input = h('input', { name: 'backend', type: 'url', required: true, value: backendUrl(), autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvează și verifică');
  const run = busy(
    save,
    async () => {
      const url = normalizeBackendUrl(input.value);
      const previous = backendOverride();
      setBackendOverride(url);
      try {
        const health = await request<{ name: string; version: string }>('GET', '/api/health');
        if (health.name !== 'nexus-chat') throw new Error('La această adresă nu răspunde un server NEXUS CHAT.');
        status.textContent = `Conectat la NEXUS CHAT ${health.version}.`;
        toast('Adresa serverului a fost salvată.', 'ok');
      } catch (err) {
        setBackendOverride(previous);
        throw err;
      }
    },
    error,
  );
  const reset = h(
    'button',
    {
      class: 'btn btn-ghost',
      type: 'button',
      onclick: () => {
        setBackendOverride(null);
        input.value = backendUrl();
        toast('Se folosește adresa implicită.', 'ok');
      },
    },
    'Revino la adresa implicită',
  );

  root.append(
    appBar({ title: 'Setări', back: '/' }),
    page(
      card(
        h('h2', null, 'Adresa serverului'),
        h('p', { class: 'muted' }, 'Adresa laptopului gazdă (de ex. https://laptop.exemplu.ts.net). Schimb-o doar la indicația administratorului.'),
        h(
          'form',
          { class: 'stack', onsubmit: (ev: Event) => (ev.preventDefault(), void run()) },
          field('Adresă', input),
          error,
          status,
          h('div', { class: 'button-row' }, save, backendOverride() ? reset : null),
        ),
      ),
      card(
        h('h2', null, 'Despre confidențialitate'),
        h('ul', { class: 'steps' }, h('li', null, 'Mesajele sunt păstrate doar pe laptopul administratorului, nu în cloud.'), h('li', null, 'Conexiunea este criptată (HTTPS) între telefon și laptop. Nu este criptare end-to-end: administratorul are acces la arhivă.'), h('li', null, 'Apelurile nu sunt înregistrate.')),
      ),
    ),
  );
}
