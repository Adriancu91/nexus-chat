import type { IncomingMessage } from 'node:http';
import type { Principal } from '../services/sessions.ts';
import type { Reply } from './http.ts';

export interface RequestContext {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  principal: Principal | null;
  body(): Promise<unknown>;
}

export type Handler = (rc: RequestContext) => Reply | Promise<Reply>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export type Match =
  | { kind: 'found'; handler: Handler; params: Record<string, string> }
  | { kind: 'method_not_allowed' }
  | { kind: 'not_found' };

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  match(method: string, pathname: string): Match {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { kind: 'found', handler: r.handler, params };
    }
    return pathMatched ? { kind: 'method_not_allowed' } : { kind: 'not_found' };
  }
}
