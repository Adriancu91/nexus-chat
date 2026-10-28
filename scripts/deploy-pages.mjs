// Publică interfața web statică pe GitHub Pages (ramura gh-pages).
//
//   npm run deploy:pages -- --backend https://laptop.tailnet.ts.net [--dry-run]
//
// Publică DOAR fișierele construite din web/dist (HTML, JS, CSS, pictograme) plus config.json
// cu adresa serverului. Nicio dată privată, niciun secret. Ramura gh-pages este generată
// automat și rescrisă la fiecare publicare.
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    remote: { type: 'string' },
    branch: { type: 'string', default: 'gh-pages' },
    'dry-run': { type: 'boolean' },
  },
});

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!values.backend) fail('Lipsește --backend https://… (adresa publică a laptopului).');
const backend = new URL(values.backend);
if (backend.protocol !== 'https:') fail('Adresa serverului trebuie să fie https://.');
const backendUrl = (backend.origin + backend.pathname).replace(/\/+$/, '');

const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const remote = values.remote ?? git(['remote', 'get-url', 'origin']);

console.log('1/4 Construiesc interfața web…');
// Comandă fixă (fără date externe), rulată prin shell pentru npm.cmd pe Windows.
execSync('npm run build -w web', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_BACKEND_URL: '' } });

const dist = path.join(root, 'web', 'dist');
writeFileSync(path.join(dist, 'config.json'), JSON.stringify({ backendUrl }, null, 2) + '\n');
if (!existsSync(path.join(dist, '.nojekyll'))) writeFileSync(path.join(dist, '.nojekyll'), '');

console.log('2/4 Verific conținutul…');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(path.relative(dist, full).replaceAll('\\', '/'));
  }
})(dist);
const allowed = /^(index\.html|config\.json|\.nojekyll|manifest\.webmanifest|icon\.svg|assets\/[\w.-]+\.(js|css))$/;
const unexpected = files.filter((f) => !allowed.test(f));
if (unexpected.length) fail(`Fișiere neașteptate în build, nu public: ${unexpected.join(', ')}`);
const secretPattern = /(BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|github_pat_|sk-[A-Za-z0-9]{20})/;
for (const f of files) {
  if (secretPattern.test(readFileSync(path.join(dist, f), 'utf8'))) fail(`Posibil secret în ${f}; opresc publicarea.`);
}
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
if (!html.includes('Content-Security-Policy')) fail('index.html nu conține CSP; opresc publicarea.');
for (const f of files) console.log(`    ${f}`);
console.log(`    config.json → backendUrl = ${backendUrl}`);

if (values['dry-run']) {
  console.log('\n--dry-run: nu am publicat nimic.');
  process.exit(0);
}

console.log(`3/4 Pregătesc ramura ${values.branch}…`);
const tmp = mkdtempSync(path.join(tmpdir(), 'nexus-pages-'));
try {
  cpSync(dist, tmp, { recursive: true });
  git(['init', '-q', '-b', values.branch], tmp);
  git(['config', 'user.name', git(['config', 'user.name'])], tmp);
  git(['config', 'user.email', git(['config', 'user.email'])], tmp);
  git(['add', '-A'], tmp);
  const source = git(['rev-parse', '--short', 'HEAD']);
  git(['commit', '-q', '-m', `Publicare interfață web (sursa ${source})`], tmp);
  console.log(`4/4 Public pe ${remote} (${values.branch})…`);
  execFileSync('git', ['push', '--force', remote, `HEAD:${values.branch}`], { cwd: tmp, stdio: 'inherit' });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('\nPublicat. GitHub Pages actualizează site-ul în 1–2 minute.');
