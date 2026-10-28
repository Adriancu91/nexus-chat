import { h, icon, type Child } from './dom.ts';

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.appendChild(el);
  window.setTimeout(() => el.classList.add('toast-hide'), kind === 'error' ? 6000 : 3000);
  window.setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

/**
 * Fereastră modală cu formular. Se rezolvă cu datele formularului la confirmare
 * sau cu null la anulare. `validate` poate întoarce un mesaj de eroare.
 */
export function dialog(opts: {
  title: string;
  body: Child[];
  confirmLabel: string;
  danger?: boolean;
  validate?: (data: FormData) => string | null;
}): Promise<FormData | null> {
  return new Promise((resolve) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const form = h(
      'form',
      { class: 'dialog-form', method: 'dialog' },
      h('h2', null, opts.title),
      ...opts.body,
      error,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(null) }, 'Anulează'),
        h('button', { type: 'submit', class: opts.danger ? 'btn btn-danger' : 'btn btn-primary' }, opts.confirmLabel),
      ),
    );
    const dlg = h('dialog', { class: 'dialog' }, form);
    const finish = (value: FormData | null) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const problem = opts.validate?.(data) ?? null;
      if (problem) {
        error.textContent = problem;
        return;
      }
      finish(data);
    });
    dlg.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish(null);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (form.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
  });
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

/** Buton care se dezactivează cât rulează acțiunea și afișează eroarea, dacă apare. */
export function busy(button: HTMLButtonElement, action: () => Promise<void>, errorEl?: HTMLElement): () => Promise<void> {
  return async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (errorEl) errorEl.textContent = '';
    try {
      await action();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'A apărut o eroare.';
      if (errorEl) errorEl.textContent = msg;
      else toast(msg, 'error');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copiat.`, 'ok');
  } catch {
    toast(`Nu am putut copia automat. ${what}: ${text}`, 'info');
  }
}

export function iconButton(name: string, label: string, onclick: () => void, extra = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `icon-btn ${extra}`, 'aria-label': label, title: label, onclick }, icon(name));
}

// ---- formatare ----

const timeFmt = new Intl.DateTimeFormat('ro-RO', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short' });

export const formatTime = (ts: number) => timeFmt.format(ts);
export const formatDateTime = (ts: number) => fullFmt.format(ts);

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Astăzi';
  if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
  return dateFmt.format(d);
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'necunoscut';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Culoare stabilă pentru numele fiecărui participant. */
export function senderHue(senderId: string): number {
  let hash = 0;
  for (const ch of senderId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}
