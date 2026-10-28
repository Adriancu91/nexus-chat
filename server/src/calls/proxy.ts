import http from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Semnalizarea LiveKit (WebSocket pe /rtc) trece prin serverul NEXUS, deci prin același
 * tunel HTTPS: nu e nevoie de încă o adresă publică. LiveKit ascultă doar pe 127.0.0.1.
 */
export function isRtcPath(pathname: string): boolean {
  return pathname === '/rtc' || pathname.startsWith('/rtc/');
}

function forwardHeaders(req: http.IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.cookie;
  return headers;
}

export function proxyRtcUpgrade(port: number, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: forwardHeaders(req, port) });
  const fail = () => {
    if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  upstream.on('upgrade', (res, upSocket, upHead) => {
    let raw = `HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) raw += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    socket.write(raw + '\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', close);
    socket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
  });
  // LiveKit a refuzat upgrade-ul (ex. bilet invalid): transmitem răspunsul așa cum e.
  upstream.on('response', (res) => {
    let raw = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) raw += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    socket.write(raw + 'Connection: close\r\n\r\n');
    res.pipe(socket);
  });
  upstream.on('error', fail);
  socket.on('error', () => upstream.destroy());
  upstream.end();
}

/** Cereri HTTP obișnuite pe /rtc (ex. /rtc/validate, folosit de client după un eșec de conectare). */
export function proxyRtcHttp(port: number, req: http.IncomingMessage, res: http.ServerResponse, extraHeaders: Record<string, string>): void {
  const upstream = http.request(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: forwardHeaders(req, port) },
    (up) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!k.startsWith('access-control-')) headers[k] = v;
      res.writeHead(up.statusCode ?? 502, { ...headers, ...extraHeaders });
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, extraHeaders).end();
    else res.destroy();
  });
  req.pipe(upstream);
}
