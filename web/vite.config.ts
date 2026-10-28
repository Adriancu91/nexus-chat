import { defineConfig, type Plugin } from 'vite';

/**
 * Content-Security-Policy pentru build-ul publicat. Doar scripturi și stiluri proprii;
 * conexiuni doar prin HTTPS/WSS (plus localhost pentru dezvoltare și laptopul gazdă).
 * Se aplică doar la build: serverul de dezvoltare Vite injectează stiluri inline.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  'connect-src https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*',
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'nexus-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  // Căi relative: aplicația funcționează și sub https://<utilizator>.github.io/nexus-chat/
  base: './',
  plugins: [csp()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
});
