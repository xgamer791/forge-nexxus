// Presentation only: menus open/close; no models, uploads, connections, or API calls.
const app = document.querySelector('.app');
const backdrop = document.querySelector('.backdrop');
const panels = [...document.querySelectorAll('[role="dialog"]')];
const navigation = document.querySelector('.navigation');
const historyContent = document.querySelector('.nav-content');
const settingsContent = document.querySelector('.settings-content');
function showSettings(show) {
  historyContent.hidden = show;
  settingsContent.hidden = !show;
  navigation.setAttribute('aria-label', show ? 'Settings menu' : 'Navigation menu');
  document.querySelector('.settings').setAttribute('aria-expanded', String(show));
}
document.querySelector('.settings').addEventListener('click', () => {
  showSettings(true);
  document.querySelector('.settings-back').focus({preventScroll:true});
});
document.querySelector('.settings-back').addEventListener('click', () => {
  showSettings(false);
  document.querySelector('.settings').focus({preventScroll:true});
});
let opener;
function closeMenu() {
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
  backdrop.hidden = name === 'attachments';
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
  if (!document.querySelector('.attachments').hidden && !event.target.closest('.attachments,[data-open]')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenu();
  if (event.key !== 'Tab') return;
  const panel = panels.find(item => !item.hidden);
  if (!panel) return;
  const controls = [...panel.querySelectorAll('button,input')].filter(control => !control.closest('[hidden]'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
// Deterministic reference framing for screenshot review; never fabricates iOS status UI.
const query = new URLSearchParams(location.search);
if (query.has('reference')) app.classList.add('reference');
if (['connections','models','attachments','navigation'].includes(query.get('screen'))) openMenu(query.get('screen'));
if (query.get('screen') === 'settings') { openMenu('navigation'); showSettings(true); }
