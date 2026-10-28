import './styles.css';
import { loadPublishedConfig } from './config.ts';
import { clear } from './dom.ts';
import { migrateBackendData } from './migrate.ts';
import { navigate } from './nav.ts';
import { renderAdmin } from './views/admin.ts';
import { renderChat } from './views/chat.ts';
import { renderHome } from './views/home.ts';
import { renderJoin } from './views/join.ts';
import { renderSettings } from './views/settings.ts';

/** O vedere desenează în `root` și întoarce o funcție de curățare (închide conexiuni etc.). */
export type View = (root: HTMLElement, params: Record<string, string>) => (() => void) | void;

const routes: [RegExp, string[], View][] = [
  [/^\/?$/, [], renderHome],
  [/^\/join(?:\/([^/]+))?$/, ['code'], renderJoin],
  [/^\/room\/([^/]+)$/, ['roomId'], (root, p) => renderChat(root, { roomId: p.roomId ?? '', asAdmin: false })],
  [/^\/admin\/room\/([^/]+)$/, ['roomId'], (root, p) => renderChat(root, { roomId: p.roomId ?? '', asAdmin: true })],
  [/^\/admin(?:\/([a-z]+))?$/, ['tab'], renderAdmin],
  [/^\/settings$/, [], renderSettings],
];

const root = document.getElementById('app')!;
let cleanup: (() => void) | void;

function route(): void {
  cleanup?.();
  cleanup = undefined;
  clear(root);
  const path = decodeURIComponentSafe(location.hash.replace(/^#/, ''));
  for (const [pattern, keys, view] of routes) {
    const m = pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (m[i + 1] !== undefined) params[k] = m[i + 1]!;
    });
    cleanup = view(root, params);
    return;
  }
  navigate('/');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '/';
  }
}

await loadPublishedConfig();
await migrateBackendData();
window.addEventListener('hashchange', route);
route();
