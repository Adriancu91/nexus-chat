import { h, icon, type Child } from '../dom.ts';

export function appBar(opts: { title: Child; subtitle?: Child; back?: string; actions?: Child[] }): HTMLElement {
  return h(
    'header',
    { class: 'appbar' },
    opts.back ? h('a', { class: 'icon-btn', href: `#${opts.back}`, 'aria-label': 'Înapoi', title: 'Înapoi' }, icon('back')) : null,
    h('div', { class: 'appbar-titles' }, h('h1', { class: 'appbar-title' }, opts.title), opts.subtitle ? h('div', { class: 'appbar-sub' }, opts.subtitle) : null),
    h('div', { class: 'appbar-actions' }, ...(opts.actions ?? [])),
  );
}

export function page(...children: Child[]): HTMLElement {
  return h('div', { class: 'page' }, ...children);
}

export function card(...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, ...children);
}
