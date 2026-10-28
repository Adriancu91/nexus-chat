const OVERRIDE_KEY = 'nexus.backendUrl';
const FALLBACK = 'http://127.0.0.1:8787';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function normalizeBackendUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Adresa trebuie să înceapă cu https://');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !isLocal) {
    throw new Error('Pentru acces din internet adresa trebuie să fie https:// (conexiune criptată).');
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/**
 * Adresa laptopului gazdă. Vine din build (VITE_BACKEND_URL) sau din setările locale
 * ale browserului. Nu se citește niciodată din link-uri, ca un link primit să nu poată
 * redirecționa pe cineva către un server străin.
 */
export function backendUrl(): string {
  const candidates = [safeGet(OVERRIDE_KEY), import.meta.env.VITE_BACKEND_URL as string | undefined, FALLBACK];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return normalizeBackendUrl(c);
    } catch {
      // valoare invalidă: încercăm următoarea
    }
  }
  return FALLBACK;
}

export function backendOverride(): string | null {
  return safeGet(OVERRIDE_KEY);
}

export function setBackendOverride(value: string | null): void {
  if (value === null) localStorage.removeItem(OVERRIDE_KEY);
  else localStorage.setItem(OVERRIDE_KEY, normalizeBackendUrl(value));
}

export function wsUrl(): string {
  return backendUrl().replace(/^http/, 'ws') + '/ws';
}

/** Link-ul de invitație într-o cameră (fără parolă). */
export function roomInviteLink(code: string): string {
  const base = location.href.split('#')[0];
  return `${base}#/join/${encodeURIComponent(code)}`;
}
