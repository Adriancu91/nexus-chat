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

let publishedBackend: string | null = null;
let publishedPrevious: string[] = [];

/**
 * Citește `config.json` publicat lângă pagină (aceeași origine, controlat de proprietarul
 * repository-ului). Permite schimbarea adresei serverului fără un build nou.
 * `previousBackendUrls` = adrese vechi ale aceluiași server (după o mutare pe alt calculator).
 */
export async function loadPublishedConfig(): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('./config.json', { cache: 'no-store', signal: ctrl.signal, credentials: 'omit' });
    window.clearTimeout(timer);
    if (!res.ok) return;
    const data = (await res.json()) as { backendUrl?: unknown; previousBackendUrls?: unknown };
    if (typeof data.backendUrl === 'string' && data.backendUrl) publishedBackend = normalizeBackendUrl(data.backendUrl);
    if (Array.isArray(data.previousBackendUrls)) {
      publishedPrevious = data.previousBackendUrls.flatMap((u) => {
        try {
          return typeof u === 'string' ? [normalizeBackendUrl(u)] : [];
        } catch {
          return [];
        }
      });
    }
  } catch {
    // fără config.json (dezvoltare) sau valoare invalidă: se folosesc celelalte surse
  }
}

/**
 * Adresele anterioare ale serverului, publicate de proprietar. Se compară cu adresa publicată,
 * nu cu o eventuală setare manuală, care poate indica tocmai serverul vechi.
 */
export function previousBackendUrls(): string[] {
  const published = publishedBackendUrl();
  return publishedPrevious.filter((u) => u !== published);
}

/** Adresa serverului fără setarea manuală din browser. */
export function publishedBackendUrl(): string {
  for (const c of [publishedBackend, import.meta.env.VITE_BACKEND_URL as string | undefined, FALLBACK]) {
    if (!c) continue;
    try {
      return normalizeBackendUrl(c);
    } catch {
      // valoare invalidă: încercăm următoarea
    }
  }
  return FALLBACK;
}

/**
 * Adresa laptopului gazdă: setarea locală a browserului, apoi `config.json` publicat,
 * apoi valoarea din build. Nu se citește niciodată din link-uri, ca un link primit să nu
 * poată redirecționa pe cineva către un server străin.
 */
export function backendUrl(): string {
  const candidates = [safeGet(OVERRIDE_KEY), publishedBackend, import.meta.env.VITE_BACKEND_URL as string | undefined, FALLBACK];
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
