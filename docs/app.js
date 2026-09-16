// Presentation only: menus open/close; no models, uploads, connections, or API calls.
// Revalidate on return so cached tabs discover new GitHub Pages releases.
const loadedVersion = document.querySelector('meta[name="app-version"]')?.content;
const cleanUrl = new URL(location.href);
const attemptedVersion = cleanUrl.searchParams.get('_update');
cleanUrl.searchParams.delete('_update');
cleanUrl.searchParams.delete('v');
history.replaceState(history.state, '', cleanUrl);
let checkingRelease = false;
async function checkRelease() {
  if (!loadedVersion || loadedVersion === 'development' || checkingRelease || document.hidden) return;
  checkingRelease = true;
  try {
    const url = new URL('./version.json', location.href);
    url.searchParams.set('t', Date.now());
    const response = await fetch(url, {cache:'no-store'});
    if (!response.ok) return;
    const {version} = await response.json();
    if (/^[a-f0-9]{40}$/.test(version) && version !== loadedVersion && version !== attemptedVersion) {
      const next = new URL(location.href);
      next.searchParams.set('_update', version);
      location.replace(next);
    }
  } catch { /* Offline use keeps the current interface available. */ }
  finally { checkingRelease = false; }
}
window.addEventListener('pageshow', checkRelease);
window.addEventListener('focus', checkRelease);
document.addEventListener('visibilitychange', checkRelease);
setInterval(checkRelease, 60000);
const app = document.querySelector('.app');
function dockToVisualViewport() {
  if (!app || app.classList.contains('reference')) return;
  const vv = window.visualViewport;
  const width = vv ? vv.width : window.innerWidth;
  const height = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  const left = vv ? vv.offsetLeft : 0;
  const appWidth = Math.min(640, width);
  const root = document.documentElement;
  root.style.setProperty('--vv-top', `${top}px`);
  root.style.setProperty('--vv-left', `${left + (width - appWidth) / 2}px`);
  root.style.setProperty('--vv-width', `${appWidth}px`);
  root.style.setProperty('--vv-height', `${height}px`);
}
dockToVisualViewport();
window.visualViewport?.addEventListener('resize', dockToVisualViewport);
window.visualViewport?.addEventListener('scroll', dockToVisualViewport);
window.addEventListener('orientationchange', dockToVisualViewport);
const backdrop = document.querySelector('.backdrop');
const appearance = document.querySelector('.appearance');
const panels = [...document.querySelectorAll('[role="dialog"]')].filter(panel => panel !== appearance);
const navigation = document.querySelector('.navigation');
const historyContent = document.querySelector('.nav-content');
const settingsContent = document.querySelector('.settings-content');
const themeColor = document.querySelector('meta[name="theme-color"]');
const statusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('forge-theme', next); } catch { /* Private mode keeps the in-session theme. */ }
  if (themeColor) themeColor.content = next === 'light' ? '#f2f2f7' : '#121315';
  if (statusBar) statusBar.content = next === 'light' ? 'default' : 'black-translucent';
  document.querySelectorAll('[data-theme-label]').forEach(label => { label.textContent = next === 'light' ? 'Light' : 'Dark'; });
  document.querySelectorAll('.theme-menu [data-theme]').forEach(option => {
    option.setAttribute('aria-selected', String(option.dataset.theme === next));
  });
}
function applyTransparency(reduce) {
  app.classList.toggle('opaque-surfaces', reduce);
}
try { applyTheme(localStorage.getItem('forge-theme') === 'light' ? 'light' : 'dark'); }
catch { applyTheme('dark'); }
function closePopovers() {
  document.querySelectorAll('.theme-menu,.font-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.theme-select,.font-select').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
function showSettings(show) {
  appearance.hidden = true;
  closePopovers();
  historyContent.hidden = show;
  settingsContent.hidden = !show;
  navigation.setAttribute('aria-label', show ? 'Settings menu' : 'Navigation menu');
  document.querySelector('.settings').setAttribute('aria-expanded', String(show));
}
function showAppearance(show) {
  closePopovers();
  if (show) {
    historyContent.hidden = true;
    settingsContent.hidden = true;
    appearance.hidden = false;
    navigation.setAttribute('aria-label', 'Appearance settings');
    document.querySelector('.appearance-back').focus({preventScroll:true});
  } else {
    appearance.hidden = true;
    showSettings(true);
    document.querySelector('.open-appearance').focus({preventScroll:true});
  }
}
document.querySelector('.settings').addEventListener('click', () => {
  showSettings(true);
  document.querySelector('.settings-back').focus({preventScroll:true});
});
document.querySelector('.settings-back').addEventListener('click', () => {
  showSettings(false);
  document.querySelector('.settings').focus({preventScroll:true});
});
document.querySelector('.open-appearance').addEventListener('click', () => showAppearance(true));
document.querySelector('.appearance-back').addEventListener('click', () => showAppearance(false));
document.querySelector('.theme-select').addEventListener('click', event => {
  event.stopPropagation();
  const menu = document.querySelector('.theme-menu');
  const open = menu.hidden;
  closePopovers();
  menu.hidden = !open;
  document.querySelector('.theme-select').setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('.theme-menu [data-theme]').forEach(option => {
  option.addEventListener('click', () => {
    applyTheme(option.dataset.theme);
    closePopovers();
  });
});
document.querySelectorAll('.font-menu button').forEach(button => button.addEventListener('click', closePopovers));
document.querySelectorAll('.font-select').forEach(button => {
  button.addEventListener('click', event => {
    event.stopPropagation();
    const menu = document.getElementById(button.dataset.fontMenu);
    const open = menu.hidden;
    closePopovers();
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
});
document.querySelectorAll('.toggle').forEach(button => {
  button.addEventListener('click', () => {
    const pressed = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(pressed));
    if (button.classList.contains('reduce-transparency')) applyTransparency(pressed);
  });
});
applyTransparency(document.querySelector('.reduce-transparency').getAttribute('aria-pressed') === 'true');
const density = document.querySelector('.density-range');
function syncDensity() { density.style.setProperty('--density', `${density.value}%`); }
density.addEventListener('input', syncDensity);
syncDensity();
let opener;
function closeMenu() {
  closePopovers();
  appearance.hidden = true;
  panels.forEach(panel => panel.hidden = true);
  backdrop.hidden = true;
  app.classList.remove("navigation-open");
  document.querySelectorAll('[data-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  opener?.focus();
}
function openMenu(name, trigger) {
  closeMenu();
  const panel = document.querySelector(`.${name}`);
  if (!panels.includes(panel)) return;
  opener = trigger;
  if (name === 'navigation') showSettings(false);
  panel.hidden = false;
  backdrop.hidden = false;
  app.classList.toggle('navigation-open', name === 'navigation');
  trigger?.setAttribute('aria-expanded', 'true');
  panel.querySelector('button')?.focus({preventScroll:true});
}
document.querySelectorAll('[data-open]').forEach(button => {
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const panel = document.querySelector(`.${button.dataset.open}`);
    if (!panel.hidden) closeMenu(); else openMenu(button.dataset.open, button);
  });
});
document.querySelectorAll('.dismiss').forEach(button => button.addEventListener('click', closeMenu));
backdrop.addEventListener('click', closeMenu);
document.addEventListener('click', event => {
  if (!event.target.closest('.theme-select,.theme-menu,.font-select,.font-menu')) closePopovers();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (![...document.querySelectorAll('.theme-menu,.font-menu')].every(menu => menu.hidden)) { closePopovers(); return; }
    if (!appearance.hidden) { showAppearance(false); return; }
    closeMenu();
  }
  if (event.key !== 'Tab') return;
  const panel = appearance.hidden ? panels.find(item => !item.hidden) : appearance;
  if (!panel) return;
  const controls = [...panel.querySelectorAll('button,input')].filter(control => !control.closest('[hidden]'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
// Deterministic reference framing for screenshot review; never fabricates iOS status UI.
const query = new URLSearchParams(location.search);
if (query.has('reference')) app.classList.add('reference');
if (query.get('theme') === 'light' || query.get('theme') === 'dark') applyTheme(query.get('theme'));
if (['connections','models','attachments','navigation'].includes(query.get('screen'))) openMenu(query.get('screen'));
if (query.get('screen') === 'settings') { openMenu('navigation'); showSettings(true); }
if (query.get('screen') === 'appearance') { openMenu('navigation'); showAppearance(true); }
if (query.get('menu') === 'theme') {
  document.querySelector('.theme-menu').hidden = false;
  document.querySelector('.theme-select').setAttribute('aria-expanded', 'true');
}

// Opt-in, device-local measurements. No viewport correction is applied here:
// agreeing with visualViewport alone does not prove the physical strip is gone.
if (query.get('viewport-debug') === '1') {
  const makeProbe = (styles) => {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;${styles}`;
    document.body.append(probe);
    return probe;
  };
  const safeAreaProbe = makeProbe('top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)');
  const fixedProbe = makeProbe('inset:0');
  const dynamicProbe = makeProbe('top:0;left:0;width:0;height:100dvh');
  const smallProbe = makeProbe('top:0;left:0;width:0;height:100svh');
  const largeProbe = makeProbe('top:0;left:0;width:0;height:100lvh');
  const report = document.createElement('pre');
  report.setAttribute('aria-hidden', 'true');
  report.dataset.viewportDiagnostics = '';
  report.style.cssText = 'position:fixed;z-index:2147483647;top:calc(env(safe-area-inset-top,0px) + 100px);left:12px;max-width:calc(100% - 24px);margin:0;padding:10px 12px;border:1px solid #7b83ff;border-radius:8px;background:#151521;color:#fff;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap;pointer-events:none;text-align:left';
  document.body.append(report);
  const number = value => Number.isFinite(value) ? String(Math.round(value * 10) / 10) : 'n/a';
  const bounds = selector => {
    const element = document.querySelector(selector);
    if (!element || element.closest('[hidden]')) return null;
    return element.getBoundingClientRect();
  };
  const bottom = selector => {
    const rect = bounds(selector);
    return rect ? number(rect.bottom) : 'closed';
  };
  const updateViewportReport = () => {
    if (document.hidden) return;
    const viewport = window.visualViewport;
    const rect = app.getBoundingClientRect();
    const safe = getComputedStyle(safeAreaProbe);
    const footer = document.querySelector('.nav-footer');
    const footerStyle = getComputedStyle(footer);
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    report.textContent = [
      `VIEWPORT DIAGNOSTICS · ${loadedVersion?.slice(0, 8)}`,
      `CSS px · ${standalone ? 'standalone' : 'browser/webview'} · ${currentTheme()}`,
      `screen ${screen.width}×${screen.height}  DPR ${devicePixelRatio}`,
      `inner ${innerWidth}×${innerHeight}  clientH ${document.documentElement.clientHeight}`,
      `VV H ${number(viewport?.height)}  top ${number(viewport?.offsetTop)}  scale ${number(viewport?.scale)}`,
      `VV bottom ${number(visibleBottom)}  scrollY ${number(scrollY)}`,
      `safe top ${safe.paddingTop}  bottom ${safe.paddingBottom}`,
      `100dvh ${number(dynamicProbe.getBoundingClientRect().height)}  svh ${number(smallProbe.getBoundingClientRect().height)}  lvh ${number(largeProbe.getBoundingClientRect().height)}`,
      `fixed bottom ${number(fixedProbe.getBoundingClientRect().bottom)}`,
      `app top ${number(rect.top)}  H ${number(rect.height)}  bottom ${number(rect.bottom)}`,
      `navigation ${bottom('.navigation')}  footer ${bottom('.nav-footer')}`,
      `footer H ${number(bounds('.nav-footer')?.height)}  pad ${footerStyle.paddingTop}/${footerStyle.paddingBottom}`,
      `composer ${bottom('.composer-area')}  VV gap ${number(visibleBottom - bounds('.composer-area').bottom)}`,
      `sheets C/M/A ${bottom('.connections')}/${bottom('.models')}/${bottom('.attachments')}`,
      `appearance ${bottom('.appearance')}  content ${bottom('.appearance-scroll')}`,
      `status mode ${statusBar?.content || 'unset'}`,
      'Screen height is not the browser viewport.',
      'Screenshot this panel AND the bottom strip.'
    ].join('\n');
  };
  updateViewportReport();
  // Also sample after drawer transitions and Safari chrome changes settle.
  setInterval(updateViewportReport, 250);
  window.addEventListener('resize', updateViewportReport);
  window.addEventListener('pageshow', updateViewportReport);
  window.visualViewport?.addEventListener('resize', updateViewportReport);
  window.visualViewport?.addEventListener('scroll', updateViewportReport);
}
