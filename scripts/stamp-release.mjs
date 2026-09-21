import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file = new URL('../docs/index.html', import.meta.url);
let html = await readFile(file, 'utf8');
const build = Number(html.match(/<meta name="app-build" content="(\d+)">/)?.[1]);
if (!Number.isInteger(build) || build < 1) throw new Error('Missing numeric app-build version');
// Content versions are identical for source-based and Actions deployments.
html = html.replace(/<meta name="app-version" content="[^"]*">/, '<meta name="app-version" content="development">');
html = html.replace(/(\.\/(?:styles\.css|app\.js|forge-data\.js|auth\.css|auth\.js|onboarding\.js)\?v=)[^"']+/g, '$1development');
const assets = await Promise.all(['app.js', 'styles.css', 'forge-data.js', 'auth.js', 'auth.css', 'onboarding.js'].map(name => readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8')));
const version = createHash('sha1').update(JSON.stringify([html, ...assets])).digest('hex');
html = html.replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${version}">`);
html = html.replace(/(\.\/(?:styles\.css|app\.js|forge-data\.js|auth\.css|auth\.js|onboarding\.js)\?v=)[^"']+/g, `$1${version}`);
await writeFile(file, html);
await writeFile(new URL('../docs/version.json', import.meta.url), JSON.stringify({version, build}));
