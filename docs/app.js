// Menus, appearance, and voice input are local; sites, credits, and the account persist through ForgeData (Convex).
// Revalidate on return so cached tabs discover new GitHub Pages releases.
const loadedVersion = document.querySelector('meta[name="app-version"]')?.content;
const cleanUrl = new URL(location.href);
const attemptedVersion = cleanUrl.searchParams.get('_update');
cleanUrl.searchParams.delete('_update');
cleanUrl.searchParams.delete('v');
history.replaceState(history.state, '', cleanUrl);
// GitHub Pages serves HTML through a CDN cache, so the reload that chases a new
// release can be handed the same old page back. Refusing to retry avoids a
// reload loop but leaves the tab on a stale build for as long as it lives, so
// allow exactly one more attempt once the cache window has passed.
const RETRY_AFTER_MS = 300000;
const openedAt = Date.now();
let retriedUpdate = false;
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
    if (!/^[a-f0-9]{40}$/.test(version) || version === loadedVersion) return;
    if (version === attemptedVersion) {
      if (retriedUpdate || Date.now() - openedAt < RETRY_AFTER_MS) return;
      retriedUpdate = true;
    }
    const next = new URL(location.href);
    next.searchParams.set('_update', version);
    location.replace(next);
  } catch { /* Offline use keeps the current interface available. */ }
  finally { checkingRelease = false; }
}
window.addEventListener('pageshow', checkRelease);
window.addEventListener('focus', checkRelease);
document.addEventListener('visibilitychange', checkRelease);
setInterval(checkRelease, 60000);
const app = document.querySelector('.app');
const backdrop = document.querySelector('.backdrop');
const appearance = document.querySelector('.appearance');
// Full-screen overlays sit above the drawer and are driven by their own back
// buttons rather than the sheet machinery, so they stay out of `panels`.
const overlays = [appearance, ...document.querySelectorAll('.overlay')].filter(Boolean);
const panels = [...document.querySelectorAll('[role="dialog"]')].filter(panel => !overlays.includes(panel));
const navigation = document.querySelector('.navigation');
const historyContent = document.querySelector('.nav-content');
const settingsContent = document.querySelector('.settings-content');
// status-bar-style=default already parks the system bar outside the web layer.
// env(safe-area-inset-top) still reports the notch because of viewport-fit=cover,
// and writing that into --status-strip reopened the empty band under the island.
function measureStatusStrip() {
  document.documentElement.style.setProperty('--status-strip', '0px');
}
measureStatusStrip();
window.addEventListener('resize', measureStatusStrip);
window.addEventListener('orientationchange', measureStatusStrip);

let themeColor = document.querySelector('meta[name="theme-color"]');
// iOS caches the standalone status-bar tint and ignores in-place edits to the
// existing tag, so replace the element to make it re-read the app background.
function refreshStatusBarTint() {
  const tint = '#ffffff';
  if (!tint) return;
  const replacement = document.createElement('meta');
  replacement.name = 'theme-color';
  replacement.content = tint;
  themeColor?.remove();
  document.head.append(replacement);
  themeColor = replacement;
}
const statusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
const promptInput = document.querySelector('.composer textarea');
const microphone = document.querySelector('.microphone');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let voicePrefix = '';
let voiceTranscript = '';

function setVoiceInputActive(active) {
  microphone?.setAttribute('aria-pressed', String(active));
  microphone?.setAttribute('aria-label', active ? 'Stop voice input' : 'Start voice input');
  if (promptInput) promptInput.placeholder = active ? 'Listening…' : 'Ask Forge';
}

function startVoiceInput() {
  if (!promptInput || !microphone) return;
  if (!SpeechRecognition) {
    promptInput.placeholder = 'Voice input is not supported in this browser';
    promptInput.focus();
    return;
  }

  recognition ??= new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  voicePrefix = promptInput.value.trim();
  if (voicePrefix) voicePrefix += ' ';
  voiceTranscript = '';

  recognition.onstart = () => setVoiceInputActive(true);
  recognition.onresult = event => {
    let interimTranscript = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) voiceTranscript += `${transcript} `;
      else interimTranscript += transcript;
    }
    promptInput.value = `${voicePrefix}${voiceTranscript}${interimTranscript}`.trimEnd();
    promptInput.dispatchEvent(new Event('input', {bubbles:true}));
  };
  recognition.onerror = event => {
    setVoiceInputActive(false);
    if (!promptInput.value) {
      promptInput.placeholder = event.error === 'not-allowed'
        ? 'Enable microphone access to use voice input'
        : 'Voice input unavailable';
    }
  };
  recognition.onend = () => {
    setVoiceInputActive(false);
    promptInput.value = promptInput.value.trimEnd();
    promptInput.focus();
  };

  try { recognition.start(); }
  catch { setVoiceInputActive(false); }
}

microphone?.addEventListener('click', () => {
  if (microphone.getAttribute('aria-pressed') === 'true') recognition?.stop();
  else startVoiceInput();
});
window.addEventListener('pagehide', () => recognition?.abort());

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('forge-theme', next); } catch { /* Private mode keeps the in-session theme. */ }
  refreshStatusBarTint();
  // Theme changes affect colors only. Switching iOS status-bar modes here
  // changes the standalone viewport geometry after the shell was measured.
  document.querySelectorAll('[data-theme-label]').forEach(label => { label.textContent = next === 'light' ? 'Light' : 'Dark'; });
  document.querySelectorAll('.theme-menu [data-theme]').forEach(option => {
    option.setAttribute('aria-selected', String(option.dataset.theme === next));
  });
}
function applyTransparency(reduce) {
  app.classList.toggle('opaque-surfaces', reduce);
}
// Appearance preferences: the device copy paints immediately, then the copy
// saved against the account replaces it as soon as Convex answers.
const SETTINGS_KEY = 'forge-settings';
const SETTING_DEFAULTS = {
  theme: 'dark',
  density: 64,
  codeWrap: false,
  themedDiff: true,
  reduceTransparency: true,
  uiFont: 'System font',
  codeFont: 'System monospace',
};
function knownSettings(values) {
  if (!values || typeof values !== 'object') return {};
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => key in SETTING_DEFAULTS && value !== null && value !== undefined)
  );
}
function readStoredSettings() {
  try {
    const saved = knownSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
    const legacyTheme = localStorage.getItem('forge-theme');
    if (saved.theme === undefined && legacyTheme) saved.theme = legacyTheme === 'light' ? 'light' : 'dark';
    return saved;
  } catch { return {}; }
}
let settings = {...SETTING_DEFAULTS, ...readStoredSettings()};
applyTheme(settings.theme);
function closePopovers() {
  document.querySelectorAll('.theme-menu,.font-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.theme-select,.font-select,.site-options').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
function closeOverlays() {
  overlays.forEach(hideOverlay);
}
function showOverlay(element) {
  closeOverlays();
  closePopovers();
  historyContent.hidden = true;
  settingsContent.hidden = true;
  element.hidden = false;
  element.classList.add('is-open');
  element.querySelector('button')?.focus({preventScroll:true});
}
function showSettings(show) {
  closeOverlays();
  closePopovers();
  historyContent.hidden = show;
  settingsContent.hidden = !show;
  navigation.setAttribute('aria-label', show ? 'Settings menu' : 'Navigation menu');
  navigation.classList.toggle('is-settings', show);
  document.querySelector('.settings').setAttribute('aria-expanded', String(show));
}
function showAppearance(show) {
  if (show) {
    showOverlay(appearance);
    navigation.setAttribute('aria-label', 'Appearance settings');
  } else {
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

function applySettings(values) {
  applyTheme(values.theme);
  density.value = String(values.density);
  syncDensity();
  document.querySelectorAll('.toggle[data-setting]').forEach(button => {
    button.setAttribute('aria-pressed', String(values[button.dataset.setting] === true));
  });
  applyTransparency(values.reduceTransparency === true);
  document.querySelectorAll('.font-select[data-setting]').forEach(select => {
    const label = select.querySelector('span');
    if (label) label.textContent = values[select.dataset.setting];
  });
}
function saveSettings(patch) {
  settings = {...settings, ...patch};
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* Private mode keeps preferences for this session only. */ }
  applySettings(settings);
  window.ForgeData?.settings?.update(patch).catch(reportError);
}
applySettings(settings);
// These listeners run after the ones that drive the controls, so the control
// has already settled on its new state by the time the change is recorded.
document.querySelectorAll('.toggle[data-setting]').forEach(button => {
  button.addEventListener('click', () => {
    saveSettings({[button.dataset.setting]: button.getAttribute('aria-pressed') === 'true'});
  });
});
document.querySelectorAll('.theme-menu [data-theme]').forEach(option => {
  option.addEventListener('click', () => saveSettings({theme: option.dataset.theme}));
});
let densitySave;
density.addEventListener('input', () => {
  clearTimeout(densitySave);
  densitySave = setTimeout(() => saveSettings({density: Number(density.value)}), 250);
});
document.querySelectorAll('.font-menu').forEach(menu => {
  const select = document.querySelector(`.font-select[aria-controls="${menu.id}"]`);
  if (!select?.dataset.setting) return;
  menu.querySelectorAll('button').forEach(option => {
    option.addEventListener('click', () => {
      menu.querySelectorAll('button').forEach(item => item.setAttribute('aria-selected', String(item === option)));
      saveSettings({[select.dataset.setting]: option.textContent});
    });
  });
});
// A signed-in account's saved preferences win over the device copy; a guest with
// nothing saved keeps whatever this device is already showing.
window.ForgeData?.settings?.subscribe(stored => {
  const saved = knownSettings(stored);
  if (Object.keys(saved).length === 0) return;
  settings = {...settings, ...saved};
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* Private mode keeps preferences for this session only. */ }
  applySettings(settings);
});
let opener;
let menuLockUntil = 0;
let menuLockTimer;
const pendingPanelHides = new WeakMap();
const DRAWER_MS = 100;
const DROPDOWN_MS = 200;
const MENU_LOCK_MS = 350;
const DRAWER_EASE = 'cubic-bezier(.45,0,.55,1)';
const DRAWER_OFF = 'translate3d(-100%,0,0)';
const DRAWER_ON = 'translate3d(0,0,0)';
const STAGE_OFF = 'translate3d(0,0,0)';
const stage = document.querySelector('.stage');
function resetViewport() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function currentTransform(element, fallback) {
  const value = getComputedStyle(element).transform;
  return !value || value === 'none' ? fallback : value;
}
function drawerWidth() {
  const drawer = document.querySelector('.navigation');
  const width = drawer?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width : 320;
}
function stageOn() {
  return `translate3d(${drawerWidth()}px,0,0)`;
}
function slideLayer(element, from, to) {
  if (!element) return Promise.resolve();
  element.getAnimations().forEach(animation => animation.cancel());
  element.style.transform = from;
  void element.offsetWidth;
  if (prefersReducedMotion()) {
    element.style.transform = to;
    return Promise.resolve();
  }
  const animation = element.animate(
    [{transform: from}, {transform: to}],
    {duration: DRAWER_MS, easing: DRAWER_EASE, fill: 'forwards'},
  );
  return animation.finished.catch(() => {}).then(() => {
    element.style.transform = to;
  });
}
function parkStage() {
  if (!stage) return;
  stage.style.transform = STAGE_OFF;
  stage.getAnimations().forEach(animation => animation.cancel());
}
function currentOpacity(element, fallback) {
  const value = Number(getComputedStyle(element).opacity);
  return Number.isFinite(value) ? value : fallback;
}
function fadeLayer(element, from, to, duration = DRAWER_MS) {
  if (!element) return Promise.resolve();
  if (Math.abs(from - to) < 0.02 && element.getAnimations().length === 0) {
    element.style.opacity = String(to);
    return Promise.resolve();
  }
  element.getAnimations().forEach(animation => animation.cancel());
  element.style.opacity = String(from);
  element.style.transform = 'none';
  void element.offsetWidth;
  if (prefersReducedMotion()) {
    element.style.opacity = String(to);
    return Promise.resolve();
  }
  const animation = element.animate(
    [{opacity: from, transform: 'none'}, {opacity: to, transform: 'none'}],
    {duration, easing: DRAWER_EASE, fill: 'forwards'},
  );
  return animation.finished.catch(() => {}).then(() => {
    element.style.opacity = String(to);
    element.style.transform = 'none';
  });
}
function dimFrom() {
  return backdrop.classList.contains('is-dim') ? currentOpacity(backdrop, 0) : 0;
}
function showDim(duration = DRAWER_MS) {
  const from = dimFrom();
  backdrop.hidden = false;
  backdrop.classList.add('is-open', 'is-dim');
  backdrop.style.transform = 'none';
  if (from > 0.98) {
    backdrop.getAnimations().forEach(animation => animation.cancel());
    backdrop.style.opacity = '1';
    return Promise.resolve();
  }
  backdrop.style.opacity = String(from);
  return fadeLayer(backdrop, from, 1, duration);
}
function dimmerInUse() {
  if (app.classList.contains('navigation-open')) return true;
  return panels.some(panel => !panel.hidden && !panel.classList.contains('is-closing'));
}
function lockMenu(ms = MENU_LOCK_MS) {
  menuLockUntil = performance.now() + ms;
  backdrop.classList.add('is-locked');
  clearTimeout(menuLockTimer);
  menuLockTimer = setTimeout(() => backdrop.classList.remove('is-locked'), ms);
}
function menuLocked() {
  return performance.now() < menuLockUntil;
}
function releaseDimmer(duration = DROPDOWN_MS) {
  if (dimmerInUse()) {
    showDim(duration);
    return;
  }
  fadeLayer(backdrop, currentOpacity(backdrop, 1), 0, duration).then(() => {
    if (dimmerInUse()) {
      showDim(duration);
      return;
    }
    finishHide(backdrop);
    if (!dimmerInUse()) app.classList.remove('sheet-open');
  });
}
function finishHide(element) {
  const pending = pendingPanelHides.get(element);
  if (pending) {
    clearTimeout(pending.timer);
    if (pending.finish) element.removeEventListener('animationend', pending.finish);
    if (pending.transition) element.removeEventListener('transitionend', pending.transition);
    pendingPanelHides.delete(element);
  }
  if (element.classList.contains('navigation')) {
    element.style.transform = DRAWER_OFF;
    element.getAnimations().forEach(animation => animation.cancel());
    parkStage();
  }
  if (element === backdrop) {
    element.style.opacity = '0';
    element.style.transform = 'none';
    element.getAnimations().forEach(animation => animation.cancel());
    element.classList.remove('is-nav', 'is-dim');
  }
  element.hidden = true;
  element.classList.remove('is-open', 'is-closing');
  element.scrollTop = 0;
}
function hideOverlay(element, {keepDim = false} = {}) {
  if (!element) return;
  if (element.classList.contains('navigation')) return;
  if (element.hidden && !element.classList.contains('is-open') && !element.classList.contains('is-closing')) return;
  if (pendingPanelHides.has(element)) {
    if (keepDim) pendingPanelHides.get(element).keepDim = true;
    return;
  }
  const reduceMotion = prefersReducedMotion();
  const animatedDropdown = element.matches?.('.dropdown.is-open') && !reduceMotion;
  if (!animatedDropdown) {
    finishHide(element);
    if (!keepDim) releaseDimmer();
    return;
  }
  element.classList.remove('is-open');
  element.classList.add('is-closing');
  const pending = {keepDim};
  const finish = event => {
    if (event?.target && event.target !== element) return;
    const stay = pending.keepDim;
    finishHide(element);
    if (stay || dimmerInUse()) return;
    releaseDimmer();
  };
  pending.finish = finish;
  pending.timer = setTimeout(() => finish(), DROPDOWN_MS + 80);
  pendingPanelHides.set(element, pending);
  element.addEventListener('animationend', finish);
  if (!keepDim) releaseDimmer();
}
function closeDrawer({keepDim = false} = {}) {
  const drawer = document.querySelector('.navigation');
  if (!drawer || drawer.hidden && !drawer.classList.contains('is-open')) {
    app.classList.remove('navigation-open');
    parkStage();
    if (!keepDim) releaseDimmer(DRAWER_MS);
    return;
  }
  if (pendingPanelHides.has(drawer)) {
    if (keepDim) pendingPanelHides.get(drawer).keepDim = true;
    return;
  }
  const pending = {keepDim};
  const done = () => {
    if (!pendingPanelHides.has(drawer)) return;
    finishHide(drawer);
    app.classList.remove('navigation-open');
    if (!pending.keepDim) releaseDimmer(DRAWER_MS);
    requestAnimationFrame(() => {
      resetViewport();
      refreshStatusBarTint();
      opener?.focus({preventScroll:true});
    });
  };
  drawer.classList.add('is-closing');
  drawer.style.transform = currentTransform(drawer, DRAWER_ON);
  if (stage) stage.style.transform = currentTransform(stage, stageOn());
  void drawer.offsetWidth;
  pending.timer = setTimeout(done, DRAWER_MS + 80);
  pendingPanelHides.set(drawer, pending);
  app.classList.remove('navigation-open');
  Promise.all([
    slideLayer(drawer, currentTransform(drawer, DRAWER_ON), DRAWER_OFF),
    slideLayer(stage, currentTransform(stage, stageOn()), STAGE_OFF),
  ]).then(done);
  if (!keepDim) releaseDimmer(DRAWER_MS);
}
function closeMenu() {
  menuLockUntil = 0;
  backdrop.classList.remove('is-locked');
  clearTimeout(menuLockTimer);
  closePopovers();
  const active = document.activeElement;
  if (active && app.contains(active) && active !== document.body) active.blur();
  closeOverlays();
  const drawer = document.querySelector('.navigation');
  const drawerClosing = Boolean(drawer?.classList.contains('is-closing'));
  const drawerOpen = Boolean(drawer?.classList.contains('is-open') && !drawerClosing);
  panels.forEach(panel => hideOverlay(panel));
  const dropdownClosing = panels.some(panel => panel.classList.contains('dropdown') && panel.classList.contains('is-closing'));
  if (drawerOpen) closeDrawer();
  else if (!drawerClosing && !dropdownClosing) {
    releaseDimmer();
    app.classList.remove('navigation-open');
    parkStage();
  } else if (dropdownClosing) {
    app.classList.remove('navigation-open');
  }
  document.querySelectorAll('[data-open],.website-preview-button').forEach(button => button.setAttribute('aria-expanded', 'false'));
  if (!drawerOpen) resetViewport();
}
function openMenu(name, trigger) {
  if (['address', 'preview-unbuilt'].includes(name) && !window.ForgeOnboarding?.canPreview()) return;
  const panel = document.querySelector(`.${name}`);
  if (!panels.includes(panel)) return;
  opener = trigger;
  if (name === 'navigation') {
    closePopovers();
    closeOverlays();
    panels.forEach(item => { if (item !== panel) hideOverlay(item, {keepDim: true}); });
    showSettings(false);
    const from = panel.classList.contains('is-closing')
      ? currentTransform(panel, DRAWER_OFF)
      : DRAWER_OFF;
    const stageFrom = panel.classList.contains('is-closing')
      ? currentTransform(stage, STAGE_OFF)
      : STAGE_OFF;
    if (pendingPanelHides.has(panel)) {
      const pending = pendingPanelHides.get(panel);
      clearTimeout(pending.timer);
      pendingPanelHides.delete(panel);
    }
    panel.hidden = false;
    panel.style.transform = from;
    if (stage) stage.style.transform = stageFrom;
    panel.classList.remove('is-closing');
    panel.classList.add('is-open');
    app.classList.add('sheet-open', 'navigation-open');
    slideLayer(panel, from, DRAWER_ON);
    slideLayer(stage, stageFrom, stageOn());
    showDim(DRAWER_MS);
    lockMenu();
    trigger?.setAttribute('aria-expanded', 'true');
    panel.querySelector('button')?.focus({preventScroll:true});
    resetViewport();
    return;
  }
  closePopovers();
  closeOverlays();
  const drawer = document.querySelector('.navigation');
  const drawerOpen = Boolean(drawer?.classList.contains('is-open') && !drawer.classList.contains('is-closing'));
  panels.forEach(item => { if (item !== panel && !item.hidden) hideOverlay(item, {keepDim: true}); });
  if (drawerOpen) closeDrawer({keepDim: true});
  document.querySelectorAll('[data-open],.website-preview-button').forEach(button => {
    if (button !== trigger) button.setAttribute('aria-expanded', 'false');
  });
  if (pendingPanelHides.has(panel)) finishHide(panel);
  if (panel.classList.contains('address')) showAddressTab('address');
  panel.hidden = false;
  panel.classList.remove('is-closing');
  panel.classList.add('is-open');
  backdrop.hidden = false;
  backdrop.classList.add('is-open');
  app.classList.add('sheet-open');
  showDim(panel.classList.contains('dropdown') ? DROPDOWN_MS : DRAWER_MS);
  lockMenu();
  trigger?.setAttribute('aria-expanded', 'true');
  // Focus the dialog itself, not its close button. iOS draws a native ring
  // around a programmatically focused button even when the app removes its
  // background, which made the bare X look circled.
  panel.tabIndex = -1;
  panel.focus({preventScroll:true});
  resetViewport();
}
document.querySelectorAll('[data-open]').forEach(button => {
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const panel = document.querySelector(`.${button.dataset.open}`);
    if (!panel.hidden && !panel.classList.contains('is-closing')) {
      if (menuLocked()) return;
      closeMenu();
    }
    else openMenu(button.dataset.open, button);
  });
});
document.querySelectorAll('.dismiss').forEach(button => button.addEventListener('click', closeMenu));
document.querySelectorAll('[data-sheet-back]').forEach(button => {
  button.addEventListener('click', () => openMenu(button.dataset.sheetBack));
});
backdrop.addEventListener('click', closeMenu);
const DISMISS_PX = 48;
const DISMISS_VEL = 0.3;
function bindSlideDismiss(element, {axis, sign, both = false, companions = []} = {}) {
  if (!element) return;
  let start = null;
  let dragging = false;
  function client(event) {
    const touch = event.touches?.[0] ?? event.changedTouches?.[0];
    return {
      x: touch?.clientX ?? event.clientX,
      y: touch?.clientY ?? event.clientY,
      t: event.timeStamp,
    };
  }
  function live() {
    return !element.hidden && element.classList.contains('is-open') && !element.classList.contains('is-closing');
  }
  function apply(delta) {
    const clamped = both ? delta : (sign < 0 ? Math.min(0, delta) : Math.max(0, delta));
    element.getAnimations().forEach(animation => animation.cancel());
    element.classList.add('is-dragging');
    element.style.transform = axis === 'x'
      ? `translate3d(${clamped}px,0,0)`
      : `translate3d(0,${clamped}px,0)`;
    companions.forEach(item => {
      if (!item?.node) return;
      item.node.getAnimations?.().forEach(animation => animation.cancel());
      const base = typeof item.base === 'function' ? item.base() : 0;
      item.node.style.transform = `translate3d(${base + clamped}px,0,0)`;
    });
  }
  function clearDrag() {
    dragging = false;
    start = null;
    element.classList.remove('is-dragging');
    element.style.transform = '';
    companions.forEach(item => { if (item?.node) item.node.style.transform = ''; });
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
    window.removeEventListener('touchcancel', onUp);
  }
  function onDown(event) {
    if (event.pointerType === 'mouse' && event.button) return;
    if (!live()) return;
    const onGrip = Boolean(event.target.closest('.handle,header,.nav-edge'));
    if (!onGrip && event.target.closest('button,a,input,textarea,select,label,[role=tab]')) return;
    start = {...client(event), id: event.pointerId ?? 'touch', grip: onGrip};
    dragging = false;
    window.addEventListener('pointermove', onMove, {passive: false});
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchmove', onMove, {passive: false});
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
  }
  function onMove(event) {
    if (!start) return;
    if (event.pointerId != null && start.id !== 'touch' && event.pointerId !== start.id) return;
    const now = client(event);
    const delta = axis === 'x' ? now.x - start.x : now.y - start.y;
    const cross = axis === 'x' ? now.y - start.y : now.x - start.x;
    if (!dragging) {
      if (Math.abs(delta) < 6 && Math.abs(cross) < 6) return;
      if (!start.grip && Math.abs(cross) > Math.abs(delta) + 4) {
        clearDrag();
        return;
      }
      dragging = true;
    }
    if (event.cancelable) event.preventDefault();
    apply(delta);
  }
  function onUp(event) {
    if (!start) return;
    if (event.pointerId != null && start.id !== 'touch' && event.pointerId !== start.id) return;
    const now = client(event);
    const delta = axis === 'x' ? now.x - start.x : now.y - start.y;
    const velocity = delta / Math.max(1, now.t - start.t);
    const wasDragging = dragging;
    const away = both
      ? Math.abs(delta) > DISMISS_PX || Math.abs(velocity) > DISMISS_VEL
      : sign < 0
        ? delta < -DISMISS_PX || velocity < -DISMISS_VEL
        : delta > DISMISS_PX || velocity > DISMISS_VEL;
    clearDrag();
    if (wasDragging && away) closeMenu();
  }
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('touchstart', onDown, {passive: true});
}
document.querySelectorAll('.dropdown').forEach(panel => bindSlideDismiss(panel, {axis: 'y', both: true}));
document.querySelectorAll('.sheet:not(.dropdown)').forEach(panel => bindSlideDismiss(panel, {axis: 'y', sign: 1}));
bindSlideDismiss(document.querySelector('.navigation'), {
  axis: 'x',
  sign: -1,
  companions: [{node: stage, base: drawerWidth}],
});
document.addEventListener('click', event => {
  if (!event.target.closest('.theme-select,.theme-menu,.font-select,.font-menu')) closePopovers();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (![...document.querySelectorAll('.theme-menu,.font-menu')].every(menu => menu.hidden)) { closePopovers(); return; }
    const overlay = overlays.find(item => !item.hidden);
    if (overlay) {
      const back = overlay.dataset.back ? document.querySelector(overlay.dataset.back) : null;
      if (back) back.click(); else showAppearance(false);
      return;
    }
    closeMenu();
  }
  if (event.key !== 'Tab') return;
  const panel = overlays.find(item => !item.hidden) ?? panels.find(item => !item.hidden);
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
if (['attachments','account','navigation','address'].includes(query.get('screen'))) openMenu(query.get('screen'));
if (query.get('screen') === 'settings') { openMenu('navigation'); showSettings(true); }
if (query.get('screen') === 'appearance') { openMenu('navigation'); showAppearance(true); }
if (query.get('menu') === 'theme') {
  document.querySelector('.theme-menu').hidden = false;
  document.querySelector('.theme-select').setAttribute('aria-expanded', 'true');
}

// Opt-in, device-local measurements. No viewport correction is applied here:
// agreeing with visualViewport alone does not prove the physical strip is gone.
function showViewportDiagnostics() {
  if (document.querySelector('[data-viewport-diagnostics]')) return;
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
      `attachments ${bottom('.attachments')}`,
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
if (query.get('viewport-debug') === '1') showViewportDiagnostics();

// A Home Screen launch has its own viewport. Let support measurements be
// opened there without reinstalling the app or switching to a browser tab.
const diagnosticTrigger = document.querySelector('.profile');
let diagnosticHold;
let diagnosticTouch;
function cancelDiagnosticHold() {
  clearTimeout(diagnosticHold);
  diagnosticTouch = null;
}
diagnosticTrigger.addEventListener('pointerdown', event => {
  cancelDiagnosticHold();
  diagnosticTouch = {x: event.clientX, y: event.clientY};
  diagnosticHold = setTimeout(() => { diagnosticHoldFired = true; showViewportDiagnostics(); }, 1000);
});
// A completed hold is a diagnostics gesture, not a tap on the account button.
let diagnosticHoldFired = false;
diagnosticTrigger.addEventListener('click', event => {
  if (!diagnosticHoldFired) return;
  diagnosticHoldFired = false;
  event.stopImmediatePropagation();
}, true);
diagnosticTrigger.addEventListener('pointermove', event => {
  if (diagnosticTouch && Math.hypot(event.clientX - diagnosticTouch.x, event.clientY - diagnosticTouch.y) > 12) cancelDiagnosticHold();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(type => diagnosticTrigger.addEventListener(type, cancelDiagnosticHold));
diagnosticTrigger.addEventListener('contextmenu', event => event.preventDefault());

// Sites, credits, and the account persist in Convex through the ForgeData bundle loaded before this script.
const forge = window.ForgeData;
function reportError(error) {
  console.error('Forge Nexxus could not save the change', error);
}
function messageOf(error) {
  return error?.data ?? error?.message ?? String(error);
}
// Notes are how a failure is shown on a phone, where there is no console to
// read. An empty text hides the note.
function showNote(element, text, bad = true) {
  if (!element) return;
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('is-bad', bad);
}
const shortDate = ms => new Date(ms).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
const money = cents => cents === 0
  ? '—'
  : `$${(cents / 100).toLocaleString('en-US', {minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2})}`;
const listedPlans = () => (catalog?.plans ?? []).filter(plan => plan.key !== 'free' && plan.monthlyPriceCents > 0);

// Sites: what the drawer lists, and what the composer builds into. A site's
// conversation is its build thread, so selecting a site opens that thread.
const siteList = document.querySelector('.site-list');
const sitesEmpty = document.querySelector('.sites-empty');
const sitesError = document.querySelector('.sites-error');
const newSite = document.querySelector('.new-site');
const thread = document.querySelector('.thread');
const composerError = document.querySelector('.composer-error');
const siteBar = document.querySelector('.site-bar');
// The thread ends where the composer area begins. Measuring it rather than
// assuming a height keeps the two flush whatever the box is carrying — the
// site bar, an error, a taller safe area — instead of leaving a band of empty
// background above the composer.
const composerArea = document.querySelector('.composer-area');
const THREAD_GAP = 8;
function measureComposerSpace() {
  if (!composerArea) return;
  const rect = composerArea.getBoundingClientRect();
  if (rect.height === 0) return;
  const below = Math.max(0, window.innerHeight - rect.bottom);
  const space = Math.round(rect.height + below + THREAD_GAP);
  document.documentElement.style.setProperty('--composer-space', `${space}px`);
}
measureComposerSpace();
if (composerArea && 'ResizeObserver' in window) {
  new ResizeObserver(measureComposerSpace).observe(composerArea);
}
window.addEventListener('resize', measureComposerSpace);
window.addEventListener('orientationchange', measureComposerSpace);
window.visualViewport?.addEventListener('resize', measureComposerSpace);
const siteBarPreview = document.querySelector('.site-bar-preview');
let sites = [];
// Whether the sites subscription has answered yet. Only a list that has
// arrived can say a remembered thread is gone.
let sitesLoaded = false;
let activeSite = null;
// Set by the preview block below; the thread and the site bar open it.
let openPreview = () => {};
if (forge?.sites && siteList && thread) {
  let activeId = null;
  let stopMessages = null;
  try { activeId = localStorage.getItem('forge-conversation'); } catch { /* Private mode starts on a fresh thread. */ }

  function rememberActive(id) {
    activeId = id;
    try {
      if (id) localStorage.setItem('forge-conversation', id);
      else localStorage.removeItem('forge-conversation');
    } catch { /* Private mode forgets the thread on reload. */ }
  }
  function optionsIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const cx of [6, 12, 18]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', 12);
      dot.setAttribute('r', 1.25);
      svg.append(dot);
    }
    return svg;
  }
  function menuItem(label, action) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', () => { closePopovers(); action(); });
    return item;
  }
  function renderSites() {
    sitesEmpty.hidden = sites.length > 0;
    siteList.replaceChildren(...sites.map(site => {
      const active = site.conversationId === activeId;
      const row = document.createElement('div');
      row.className = 'site';
      row.classList.toggle('is-active', active);
      const dot = document.createElement('span');
      dot.className = 'site-dot';
      dot.dataset.status = site.status;
      dot.setAttribute('aria-hidden', 'true');
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'site-title';
      title.textContent = site.name;
      title.setAttribute('aria-current', String(active));
      title.addEventListener('click', () => { selectConversation(site.conversationId); closeMenu(); });
      const options = document.createElement('button');
      options.type = 'button';
      options.className = 'site-options';
      options.setAttribute('aria-label', `Options for ${site.name}`);
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'false');
      options.append(optionsIcon());
      const menu = document.createElement('div');
      menu.className = 'font-menu site-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      menu.append(
        menuItem('Preview', () => { selectConversation(site.conversationId); openPreview(); }),
        menuItem('Rename', () => {
          const next = prompt('Rename site', site.name)?.trim();
          if (next && next !== site.name) forge.sites.rename(site._id, next).catch(error => showNote(sitesError, messageOf(error)));
        }),
        menuItem('Delete', () => {
          if (confirm(`Delete "${site.name}" and its build thread?`)) forge.sites.remove(site._id).catch(error => showNote(sitesError, messageOf(error)));
        })
      );
      options.addEventListener('click', event => {
        event.stopPropagation();
        const open = menu.hidden;
        closePopovers();
        menu.hidden = !open;
        options.setAttribute('aria-expanded', String(open));
      });
      row.append(dot, title, options, menu);
      return row;
    }));
  }
  function renderThread(messages) {
    thread.replaceChildren(...messages.map(message => {
      const row = document.createElement('div');
      row.className = `message message-${message.role}`;
      if (message.status) row.classList.add(`message-${message.status}`);
      const body = document.createElement('p');
      // The server writes what a pending message says, since only it knows
      // whether this turn is a build or an answer. The fallback covers a
      // request that was already in flight when that started being true.
      body.textContent = message.body || (message.status === 'pending' ? 'Working…' : '');
      row.append(body);
      if (message.role === 'assistant' && message.versionId) {
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'message-view';
        view.textContent = 'View the site';
        view.disabled = !window.ForgeOnboarding?.canPreview();
        view.addEventListener('click', () => openPreview());
        row.append(view);
      }
      return row;
    }));
    app.classList.toggle('has-thread', messages.length > 0);
    thread.scrollTop = thread.scrollHeight;
  }
  // The bar names the site the composer is building into.
  function renderSiteBar() {
    activeSite = sites.find(site => site.conversationId === activeId) ?? null;
    if (siteBar) siteBar.hidden = !activeSite;
    app.classList.toggle('has-site-bar', Boolean(activeSite));
    if (activeSite) {
      document.querySelectorAll('[data-site-name]').forEach(element => { element.textContent = activeSite.name; });
      document.querySelectorAll('[data-site-status]').forEach(element => {
        element.textContent = activeSite.status === 'published' ? 'Published' : activeSite.currentVersionId ? 'Draft' : 'Not built yet';
      });
      if (siteBarPreview) {
        siteBarPreview.dataset.built = String(Boolean(activeSite.currentVersionId));
        siteBarPreview.disabled = !activeSite.currentVersionId || !window.ForgeOnboarding?.canPreview();
      }
    }
    if (promptInput) {
      promptInput.placeholder = activeSite?.currentVersionId ? 'Describe a change…' : 'Describe the site you want…';
    }
    document.dispatchEvent(new CustomEvent('forge:active-site'));
  }
  function selectConversation(id) {
    stopMessages?.();
    stopMessages = null;
    rememberActive(id);
    renderSites();
    renderSiteBar();
    if (!id) { renderThread([]); return; }
    stopMessages = forge.messages.subscribe(id, renderThread);
  }
  forge.sites.subscribe(list => {
    sites = Array.isArray(list) ? list : [];
    sitesLoaded = true;
    const activeGone = activeId && forge.auth.state().signedIn && !sites.some(site => site.conversationId === activeId);
    if (activeGone) selectConversation(null);
    else { renderSites(); renderSiteBar(); }
    document.dispatchEvent(new CustomEvent('forge:sites'));
  });
  siteBarPreview?.addEventListener('click', () => openPreview());
  if (activeId) selectConversation(activeId);

  function createSite(name) {
    return forge.sites.create(name).then(({conversationId}) => {
      selectConversation(conversationId);
      return conversationId;
    });
  }
  newSite?.addEventListener('click', () => {
    showNote(sitesError, '');
    const begin = window.ForgeOnboarding?.enabled
      ? window.ForgeOnboarding.start()
      : createSite();
    begin.then(() => {
      closeMenu();
      if (!window.ForgeOnboarding?.enabled) promptInput?.focus({preventScroll:true});
    }).catch(error => {
      reportError(error);
      showNote(sitesError, messageOf(error));
    });
  });
  document.addEventListener('forge:onboarding-complete', event => {
    const site = sites.find(site => site._id === event.detail.siteId);
    if (site) selectConversation(site.conversationId);
    closeMenu();
  });

  // The first prompt names the site. Building needs an account, so a guest
  // who gets this far is sent to sign in rather than silently refused.
  async function sendPrompt() {
    const body = promptInput.value.trim();
    if (!body) return;
    if (forge.auth.state().kind !== 'member') { openMenu('account', promptInput); return; }
    if (window.ForgeOnboarding?.enabled && summary?.plan.key !== 'free' && !activeSite?.currentVersionId) {
      await window.ForgeOnboarding.start();
      return;
    }
    promptInput.value = '';
    showNote(composerError, '');
    try {
      let id = activeId;
      // Before the list arrives, the remembered thread is still the thread.
      // Reading an empty list as "it is gone" would start a second site and
      // charge a first build for what should have been an edit.
      if (!id || (sitesLoaded && !sites.some(site => site.conversationId === id))) {
        id = await createSite(body.length > 48 ? `${body.slice(0, 47).trimEnd()}…` : body);
      }
      await forge.sites.generate(id, body);
    } catch (error) {
      promptInput.value = body;
      reportError(error);
      showNote(composerError, messageOf(error));
    }
  }
  promptInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendPrompt();
    }
  });
}

// The account: the footer, the account sheet, the Profile screen, and the
// greeting all render from one subscription.
const accountSheet = document.querySelector('.account');
const greetingTitle = document.querySelector('[data-greeting]');
if (forge?.account && accountSheet) {
  const guestView = accountSheet.querySelector('.account-guest');
  const memberView = accountSheet.querySelector('.account-member');
  const emailForm = accountSheet.querySelector('.account-email');
  const emailSent = accountSheet.querySelector('.account-sent');
  const labels = document.querySelectorAll('[data-account-label]');
  const avatars = document.querySelectorAll('[data-account-avatar]');
  const names = document.querySelectorAll('[data-account-name]');
  const emails = document.querySelectorAll('[data-account-email]');
  function renderAccount(user) {
    const member = user && !user.isAnonymous;
    guestView.hidden = Boolean(member);
    memberView.hidden = !member;
    const name = member ? (user.name || user.email || 'Signed in') : 'Guest';
    labels.forEach(label => { label.textContent = name; });
    avatars.forEach(avatar => { avatar.textContent = name.trim().charAt(0).toUpperCase() || 'G'; });
    names.forEach(element => { element.textContent = member ? name : ''; });
    emails.forEach(element => { element.textContent = member && user.email && user.email !== name ? user.email : ''; });
    if (greetingTitle) {
      const first = member && user.name ? user.name.trim().split(/\s+/)[0] : '';
      greetingTitle.textContent = first ? `Let's build, ${first}.` : 'What will you build today?';
    }
    if (!member) {
      emailForm.hidden = false;
      emailSent.hidden = true;
      accountSheet.querySelectorAll('[data-provider]').forEach(button => { button.disabled = false; });
    }
  }
  renderAccount(null);
  forge.account.subscribe(renderAccount);
  emailForm.addEventListener('submit', async event => {
    event.preventDefault();
    const email = emailForm.elements.email.value.trim();
    const submit = emailForm.querySelector('button');
    if (!email || submit.disabled) return;
    submit.disabled = true;
    try {
      await forge.auth.signInWithEmail(email);
      emailForm.hidden = true;
      emailSent.hidden = false;
    } catch (error) {
      reportError(error);
    } finally {
      submit.disabled = false;
    }
  });
  accountSheet.querySelectorAll('[data-provider]').forEach(button => {
    button.addEventListener('click', () => {
      button.disabled = true;
      forge.auth.signInWith(button.dataset.provider).catch(error => {
        button.disabled = false;
        reportError(error);
      });
    });
  });
  // Starting the replacement guest session still needs the network, so the
  // button says it is working rather than looking ignored, and a failure is
  // said out loud: there is no console to read on a phone.
  document.querySelectorAll('.account-signout,.profile-signout').forEach(signOutButton => {
    const signOutError = signOutButton.closest('.account, .overlay')?.querySelector('.account-error,.overlay-error');
    signOutButton.addEventListener('click', () => {
      if (signOutButton.disabled) return;
      signOutButton.disabled = true;
      signOutButton.textContent = 'Signing out…';
      showNote(signOutError, '');
      forge.auth.signOut()
        .then(closeMenu)
        .catch(error => {
          reportError(error);
          showNote(signOutError, `Could not sign out: ${messageOf(error)}`);
        })
        .finally(() => {
          signOutButton.disabled = false;
          signOutButton.textContent = 'Sign out';
        });
    });
  });
}

// Settings screens are full-screen overlays opened from the settings list.
// `data-back` on each section is what the back button and Escape use.
const settingsScreens = {
  profile: {element: document.querySelector('.overlay.profile-screen'), opener: '.open-profile', label: 'Profile'},
  plan: {element: document.querySelector('.overlay.plan'), opener: '.open-plan', label: 'Plan and credits'},
  usage: {element: document.querySelector('.overlay.usage'), opener: '.open-usage', label: 'Usage'},
  domains: {element: document.querySelector('.overlay.domains'), opener: '.open-domains', label: 'Domains'},
};
function showSettingsScreen(name, show = true) {
  if (name === 'domains' && !window.ForgeOnboarding?.canPreview()) return;
  const screen = settingsScreens[name];
  if (!screen?.element) return;
  if (show) {
    showOverlay(screen.element);
    navigation.setAttribute('aria-label', screen.label);
  } else {
    showSettings(true);
    document.querySelector(screen.opener)?.focus({preventScroll:true});
  }
}
Object.entries(settingsScreens).forEach(([name, screen]) => {
  document.querySelectorAll(screen.opener).forEach(button => button.addEventListener('click', () => showSettingsScreen(name)));
  screen.element?.querySelector(`.${name}-back`)?.addEventListener('click', () => showSettingsScreen(name, false));
});
document.querySelectorAll('.credits-summary,[data-credits-cta],.open-plan-from-domains').forEach(button => {
  button.addEventListener('click', () => showSettingsScreen('plan'));
});

// Plan and credits. The balance and the catalog both come from the
// deployment; the card hides for guests, who have no plan to show.
const creditsCard = document.querySelector('.credits-card');
const planScreen = document.querySelector('.overlay.plan');
let summary = null;
let catalog = null;
function setText(selector, text) {
  document.querySelectorAll(selector).forEach(element => { element.textContent = text; });
}
function setFill(selector, available, granted) {
  const percent = granted > 0 ? Math.max(0, Math.min(100, Math.round((100 * available) / granted))) : 0;
  document.querySelectorAll(selector).forEach(element => { element.style.width = `${percent}%`; });
}
function renderCredits() {
  if (creditsCard) creditsCard.hidden = !summary;
  setText('[data-settings-plan]', summary ? summary.plan.name : '');
  if (summary) {
    const {plan, unlimited, granted, periodEnd, cancelAtPeriodEnd} = summary;
    const available = unlimited ? null : summary.available;
    const used = unlimited ? null : Math.max(0, granted - available);
    const when = shortDate(periodEnd);
    const listed = listedPlans();
    const top = listed[listed.length - 1]?.key ?? null;
    setText('[data-credits-plan]', `${plan.name} plan`);
    setText('[data-credits-available]', unlimited ? 'Unlimited' : String(available));
    setText('[data-credits-granted]', unlimited ? ' credits' : ` of ${granted}`);
    setFill('[data-credits-fill]', unlimited ? 1 : available, unlimited ? 1 : granted);
    setText('[data-credits-resets]', cancelAtPeriodEnd
      ? `Ending ${when}`
      : plan.monthlyPriceCents ? `Renews ${when}` : granted > 0 ? `Expires ${when}` : 'Choose a plan to start building');
    setText('[data-credits-cta]', plan.key === top ? (plan.topUps && !unlimited ? 'Top up' : 'Manage') : 'Upgrade');
    setText('[data-plan-name]', `${plan.name} plan`);
    setText('[data-plan-renews]', cancelAtPeriodEnd
      ? `Ends ${when}`
      : plan.monthlyPriceCents ? `Renews ${when}` : granted > 0 ? `Credits expire ${when}` : 'No monthly credits');
    setText('[data-plan-price]', plan.monthlyPriceCents ? `${money(plan.monthlyPriceCents)}/mo` : '—');
    setText('[data-plan-meter-label]', unlimited ? 'Credits' : 'Credits remaining');
    setText('[data-plan-meter]', unlimited ? 'Unlimited' : `${available} of ${granted}`);
    setFill('[data-plan-fill]', unlimited ? 1 : available, unlimited ? 1 : granted);
    setText('[data-plan-resets]', unlimited
      ? `No credit limit on ${plan.name} · renews ${when}`
      : `${used} used · resets ${when} · unused credits don't roll over`);
    setText('[data-plan-end]', when);
    setText('[data-usage-headline]', unlimited ? `Unlimited credits on ${plan.name}` : `${used} of ${granted} credits used`);
    setText('[data-usage-sub]', unlimited ? `Renews ${when}` : `${available} left · resets ${when}`);
    if (planScreen) {
      planScreen.querySelector('.plan-billing').hidden = !summary.billingAccount;
      planScreen.querySelector('.plan-cancel').hidden = plan.key === 'free' || cancelAtPeriodEnd;
      planScreen.querySelector('.plan-resume').hidden = !cancelAtPeriodEnd;
      planScreen.querySelector('.plan-scheduled').hidden = !cancelAtPeriodEnd;
    }
  }
  renderPlanCards();
  document.dispatchEvent(new CustomEvent('forge:billing'));
}
function checkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#check');
  svg.append(use);
  return svg;
}
async function startCheckout(choice, button) {
  const error = planScreen?.querySelector('.overlay-error');
  showNote(error, '');
  button.disabled = true;
  try {
    const {url} = await forge.billing.checkout(choice);
    location.assign(url);
  } catch (caught) {
    reportError(caught);
    showNote(error, messageOf(caught));
    button.disabled = false;
  }
}
function renderPlanCards() {
  const cards = planScreen?.querySelector('[data-plan-cards]');
  const topUps = planScreen?.querySelector('[data-topup-list]');
  if (!cards || !topUps || !catalog) return;
  const plans = listedPlans();
  const order = plans.map(plan => plan.key);
  const current = summary?.plan.key ?? null;
  cards.replaceChildren(...plans.map(plan => {
    const card = document.createElement('article');
    card.className = 'plan-card';
    card.classList.toggle('is-current', plan.key === current);
    const title = document.createElement('h4');
    title.textContent = plan.name;
    if (plan.key === current) {
      const badge = document.createElement('span');
      badge.className = 'plan-current-badge';
      badge.textContent = 'Current';
      title.append(badge);
    }
    const tagline = document.createElement('p');
    tagline.className = 'plan-tagline';
    tagline.textContent = plan.tagline;
    const price = document.createElement('p');
    price.className = 'plan-price';
    const amount = document.createElement('strong');
    amount.textContent = money(plan.monthlyPriceCents);
    const per = document.createElement('span');
    per.textContent = plan.monthlyPriceCents ? '/ month' : 'forever';
    price.append(amount, per);
    const yearly = document.createElement('small');
    yearly.className = 'plan-yearly';
    yearly.hidden = !plan.yearlyPriceCents;
    if (plan.yearlyPriceCents) {
      yearly.textContent = `or ${money(Math.round(plan.yearlyPriceCents / 12))}/mo billed yearly (${money(plan.yearlyPriceCents)}/yr)`;
    }
    const features = document.createElement('ul');
    features.className = 'plan-features';
    [
      plan.monthlyCredits === null
        ? 'Unlimited credits'
        : plan.monthlyCredits > 0 ? `${plan.monthlyCredits} credits a month` : `${plan.signupCredits} credits to start`,
      plan.maxSites === null ? 'Unlimited sites' : plan.maxSites === 1 ? '1 site' : `Up to ${plan.maxSites} sites`,
      plan.visitorsPerMonth ? `Up to ${plan.visitorsPerMonth.toLocaleString('en-US')} visitors a month` : null,
      plan.publicAddress ? 'Publish to an address of your own' : null,
      plan.customDomains ? 'Custom domain' : null,
      plan.removeBadge ? 'No Forge badge' : null,
      plan.topUps ? 'Buy extra credits any time' : null,
      ...(plan.features ?? []),
    ].filter(Boolean).forEach(text => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = text;
      item.append(checkIcon(), label);
      features.append(item);
    });
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'plan-cta';
    if (plan.key === current) {
      cta.textContent = 'Current plan';
      cta.disabled = true;
      cta.classList.add('is-secondary');
    } else {
      const upgrade = current === null || order.indexOf(plan.key) > order.indexOf(current);
      cta.textContent = upgrade ? 'Upgrade' : 'Switch';
      if (!upgrade) cta.classList.add('is-secondary');
      cta.addEventListener('click', () => startCheckout({plan: plan.key}, cta));
    }
    card.append(title, tagline, price, yearly, features, cta);
    return card;
  }));
  // Extra credits are a plan entitlement, and pointless on an unlimited plan.
  const showTopUps = Boolean(summary?.plan.topUps) && !summary?.unlimited;
  planScreen.querySelectorAll('.topup-heading,[data-topup-list],.topup-note').forEach(element => { element.hidden = !showTopUps; });
  topUps.replaceChildren(...catalog.topUps.map(pack => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'topup-row';
    const copy = document.createElement('span');
    const credits = document.createElement('strong');
    credits.textContent = `${pack.credits} credits`;
    const note = document.createElement('small');
    note.textContent = 'Added to this period';
    copy.append(credits, note);
    const price = document.createElement('span');
    price.className = 'topup-price';
    price.textContent = money(pack.priceCents);
    row.append(copy, price);
    row.addEventListener('click', () => startCheckout({topUp: pack.key}, row));
    return row;
  }));
}
if (forge?.billing && planScreen) {
  planScreen.querySelector('.plan-cancel').addEventListener('click', () => {
    const error = planScreen.querySelector('.overlay-error');
    showNote(error, '');
    forge.billing.cancel().catch(caught => showNote(error, messageOf(caught)));
  });
  planScreen.querySelector('.plan-resume').addEventListener('click', () => {
    const error = planScreen.querySelector('.overlay-error');
    showNote(error, '');
    forge.billing.resume().catch(caught => showNote(error, messageOf(caught)));
  });
  planScreen.querySelector('.plan-billing').addEventListener('click', async event => {
    const button = event.currentTarget;
    const error = planScreen.querySelector('.overlay-error');
    showNote(error, '');
    button.disabled = true;
    try {
      const {url} = await forge.billing.portal();
      location.assign(url);
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
      button.disabled = false;
    }
  });
  // Back from Stripe: say what happened, then drop the marker from the URL.
  const checkoutResult = query.get('checkout');
  if (checkoutResult === 'success' || checkoutResult === 'cancel') {
    window.forgePaymentPending = checkoutResult === 'success';
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('checkout');
    history.replaceState(history.state, '', cleaned);
    openMenu('navigation');
    showSettings(true);
    showSettingsScreen('plan');
    showNote(planScreen.querySelector('.overlay-error'),
      checkoutResult === 'success' ? 'Payment received. Your plan updates here in a moment.' : 'Checkout cancelled. Nothing was charged.',
      checkoutResult !== 'success');
  }
  forge.billing.subscribe(next => { summary = next ?? null; renderCredits(); });
  forge.billing.catalog(next => { catalog = next ?? null; renderCredits(); });
}

// Usage: the credit ledger, newest first.
const usageScreen = document.querySelector('.overlay.usage');
if (forge?.billing && usageScreen) {
  const ledger = usageScreen.querySelector('[data-ledger]');
  const empty = usageScreen.querySelector('[data-ledger-empty]');
  const KIND_LABELS = {grant: 'Monthly credits', topup: 'Top-up', spend: 'Build request', refund: 'Refund', expire: 'Credits expired', adjust: 'Adjustment'};
  forge.billing.history(list => {
    const entries = Array.isArray(list) ? list : [];
    empty.hidden = entries.length > 0;
    ledger.replaceChildren(...entries.map(entry => {
      const row = document.createElement('div');
      row.className = 'ledger-row';
      const copy = document.createElement('span');
      copy.className = 'ledger-copy';
      const label = document.createElement('strong');
      label.textContent = entry.note || KIND_LABELS[entry.kind] || entry.kind;
      const when = document.createElement('small');
      when.textContent = new Date(entry.createdAt).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
      copy.append(label, when);
      const amount = document.createElement('span');
      amount.className = `ledger-amount ${entry.amount >= 0 ? 'is-plus' : 'is-minus'}`;
      amount.textContent = `${entry.amount >= 0 ? '+' : '−'}${Math.abs(entry.amount)}`;
      const balance = document.createElement('small');
      balance.className = 'ledger-balance';
      balance.textContent = `${entry.balanceAfter} left`;
      row.append(copy, amount, balance);
      return row;
    }));
  });
}

// Domains: a hostname pointed at one of the account's sites. The form only
// shows when the plan allows custom domains and there is a site to point at.
const domainsScreen = document.querySelector('.overlay.domains');
if (forge?.domains && domainsScreen) {
  const form = domainsScreen.querySelector('.domain-form');
  const select = form.elements.siteId;
  const list = domainsScreen.querySelector('[data-domain-list]');
  const empty = domainsScreen.querySelector('[data-domain-empty]');
  const gate = domainsScreen.querySelector('.domain-gate');
  const noSites = domainsScreen.querySelector('.domain-nosites');
  const error = domainsScreen.querySelector('.overlay-error');
  const STATUS_LABELS = {pending: 'Pending', active: 'Active', failed: 'Failed'};
  let domains = [];
  function renderAccess() {
    const allowed = Boolean(summary?.plan.customDomains);
    const cheapest = catalog?.plans.find(plan => plan.customDomains);
    setText('[data-domain-plan]', cheapest?.name ?? '');
    gate.hidden = allowed || !cheapest;
    noSites.hidden = !allowed || sites.length > 0;
    form.hidden = !allowed || sites.length === 0;
    const chosen = select.value;
    select.replaceChildren(...sites.map(site => new Option(site.name, site._id)));
    if (sites.some(site => site._id === chosen)) select.value = chosen;
  }
  function renderDomains() {
    empty.hidden = domains.length > 0;
    document.querySelectorAll('[data-settings-domains]').forEach(element => {
      element.textContent = domains.length ? String(domains.length) : '';
      element.hidden = domains.length === 0;
    });
    list.replaceChildren(...domains.map(domain => {
      const row = document.createElement('div');
      row.className = 'domain-row';
      const copy = document.createElement('span');
      copy.className = 'domain-copy';
      const host = document.createElement('strong');
      host.textContent = domain.hostname;
      const site = document.createElement('small');
      const named = sites.find(item => item._id === domain.siteId)?.name ?? 'Site removed';
      // One record is all a domain needs, so the row carries it rather than
      // sending the user somewhere else to read it.
      site.textContent = domain.record?.value
        ? `${named} · ${domain.record.type} ${domain.record.name} → ${domain.record.value}`
        : named;
      copy.append(host, site);
      if (domain.note) {
        const said = document.createElement('small');
        said.textContent = domain.note;
        copy.append(said);
      }
      const status = document.createElement('span');
      status.className = `status-chip is-${domain.status}`;
      status.textContent = STATUS_LABELS[domain.status] ?? domain.status;
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.className = 'link-button';
      verify.textContent = domain.status === 'active' ? 'Recheck' : 'Verify';
      verify.addEventListener('click', async () => {
        showNote(error, '');
        verify.disabled = true;
        try { await forge.domains.verify(domain._id); }
        catch (caught) { reportError(caught); showNote(error, messageOf(caught)); }
        finally { verify.disabled = false; }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button';
      remove.setAttribute('aria-label', `Remove ${domain.hostname}`);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#close');
      icon.append(use);
      remove.append(icon);
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${domain.hostname}?`)) return;
        showNote(error, '');
        forge.domains.remove(domain._id).catch(caught => showNote(error, messageOf(caught)));
      });
      row.append(copy, status, verify, remove);
      return row;
    }));
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('.chip-button');
    if (submit.disabled) return;
    showNote(error, '');
    submit.disabled = true;
    try {
      await forge.domains.add(select.value, form.elements.hostname.value);
      form.elements.hostname.value = '';
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
    } finally {
      submit.disabled = false;
    }
  });
  forge.domains.subscribe(next => {
    domains = Array.isArray(next) ? next : [];
    renderDomains();
  });
  document.addEventListener('forge:sites', () => { renderAccess(); renderDomains(); });
  document.addEventListener('forge:billing', renderAccess);
  renderAccess();
}

// Profile: the name, the linked sign-in methods, and the way out.
const profileScreen = document.querySelector('.overlay.profile-screen');
if (forge?.account && profileScreen) {
  const form = profileScreen.querySelector('.profile-form');
  const nameField = form.elements.name;
  const error = profileScreen.querySelector('.overlay-error');
  const providerList = profileScreen.querySelector('[data-provider-list]');
  const providerEmpty = profileScreen.querySelector('[data-provider-empty]');
  const PROVIDER_NAMES = {resend: 'Email link', google: 'Google', apple: 'Apple'};
  forge.account.subscribe(user => {
    if (document.activeElement === nameField) return;
    nameField.value = user && !user.isAnonymous ? (user.name ?? '') : '';
  });
  forge.account.providers(list => {
    const names = (Array.isArray(list) ? list : []).map(provider => PROVIDER_NAMES[provider] ?? provider);
    providerEmpty.hidden = names.length > 0;
    providerList.replaceChildren(...names.map(name => {
      const row = document.createElement('div');
      row.className = 'appearance-row provider-row';
      const label = document.createElement('strong');
      label.textContent = name;
      row.append(label, checkIcon());
      return row;
    }));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('.chip-button');
    if (submit.disabled) return;
    showNote(error, '');
    submit.disabled = true;
    try {
      await forge.account.updateProfile(nameField.value);
      showNote(error, 'Saved.', false);
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
    } finally {
      submit.disabled = false;
    }
  });
  const deleteButton = profileScreen.querySelector('.profile-delete');
  deleteButton.addEventListener('click', async () => {
    if (!confirm('Delete your account and everything in it? This cannot be undone.')) return;
    showNote(error, '');
    deleteButton.disabled = true;
    try {
      await forge.account.deleteAccount();
      closeMenu();
    } catch (caught) {
      reportError(caught);
      showNote(error, `Could not delete the account: ${messageOf(caught)}`);
    } finally {
      deleteButton.disabled = false;
    }
  });
}

// Preview: the latest build in a sandboxed frame, with publishing. The frame
// gets the page as srcdoc, so nothing in a build can run or reach this origin.
const previewScreen = document.querySelector('.overlay.preview');
if (forge?.sites && previewScreen) {
  const frame = previewScreen.querySelector('.preview-iframe');
  const empty = previewScreen.querySelector('.preview-empty');
  const status = previewScreen.querySelector('[data-preview-status]');
  const link = previewScreen.querySelector('[data-preview-link]');
  const publishButton = previewScreen.querySelector('.preview-publish');
  const unpublishButton = previewScreen.querySelector('.preview-unpublish');
  const downloadButton = previewScreen.querySelector('.preview-download');
  const error = previewScreen.querySelector('.overlay-error');
  let stopHtml = null;
  let shownSiteId = null;
  let current = null;
  function renderPreview() {
    const site = activeSite;
    const built = Boolean(site?.currentVersionId);
    const addressable = Boolean(summary?.plan.publicAddress);
    empty.hidden = built && current !== null;
    if (!built) { frame.removeAttribute('srcdoc'); current = null; }
    publishButton.disabled = !built || !addressable;
    publishButton.textContent = site?.status === 'published'
      ? (current && !current.published ? 'Publish latest build' : 'Published')
      : 'Publish';
    if (site?.status === 'published' && current?.published) publishButton.disabled = true;
    unpublishButton.hidden = site?.status !== 'published';
    downloadButton.hidden = !(built && current && summary?.plan.codeDownload);
    link.hidden = !site?.publishedUrl;
    if (site?.publishedUrl) { link.href = site.publishedUrl; link.textContent = site.publishedUrl.replace(/^https?:\/\//, ''); }
    status.textContent = !built
      ? ''
      : !addressable
        ? 'Publishing to an address of your own comes with a paid plan.'
        : current
          ? `${current.summary || 'Latest build'} · ${new Date(current.createdAt).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}`
          : 'Loading the latest build…';
  }
  function watch() {
    const siteId = activeSite?._id ?? null;
    if (siteId === shownSiteId) return;
    stopHtml?.();
    stopHtml = null;
    shownSiteId = siteId;
    current = null;
    frame.removeAttribute('srcdoc');
    if (!siteId) return;
    stopHtml = forge.sites.currentHtml(siteId, next => {
      current = next ?? null;
      if (current) frame.srcdoc = current.html;
      renderPreview();
    });
  }
  openPreview = () => {
    if (!window.ForgeOnboarding?.canPreview()) return;
    if (!previewScreen.hidden) {
      if (menuLocked()) return;
      closeMenu();
      return;
    }
    closePopovers();
    panels.forEach(item => { if (!item.hidden) hideOverlay(item, {keepDim: true}); });
    const drawer = document.querySelector('.navigation');
    if (drawer?.classList.contains('is-open') && !drawer.classList.contains('is-closing')) {
      closeDrawer({keepDim: true});
    }
    showNote(error, '');
    showOverlay(previewScreen);
    lockMenu();
    document.querySelector('.website-preview-button')?.setAttribute('aria-expanded', 'true');
    navigation.setAttribute('aria-label', 'Site preview');
    watch();
    renderPreview();
  };
  previewScreen.querySelector('.preview-back').addEventListener('click', closeMenu);
  publishButton.addEventListener('click', async () => {
    if (!activeSite || publishButton.disabled) return;
    showNote(error, '');
    publishButton.disabled = true;
    try {
      await forge.sites.publish(activeSite._id);
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
      publishButton.disabled = false;
    }
  });
  // The page as the preview shows it, as a file: what a paid plan can take away.
  downloadButton.addEventListener('click', () => {
    if (!current || !activeSite) return;
    const name = (activeSite.slug || activeSite.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site') + '.html';
    const url = URL.createObjectURL(new Blob([current.html], {type: 'text/html'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  unpublishButton.addEventListener('click', async () => {
    if (!activeSite) return;
    if (!confirm('Take this site offline? The address is kept for when you publish again.')) return;
    showNote(error, '');
    try {
      await forge.sites.unpublish(activeSite._id);
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
    }
  });
  document.addEventListener('forge:active-site', () => {
    if (previewScreen.hidden) return;
    watch();
    renderPreview();
  });
  document.addEventListener('forge:billing', () => {
    if (summary?.plan.key === 'free') { frame.removeAttribute('srcdoc'); current = null; if (!previewScreen.hidden) closeMenu(); }
    else if (!previewScreen.hidden) renderPreview();
  });
}

// Free members keep the dashboard, with the eye and globe visibly disabled.
// Paid members can preview their built site or start another site's questions.
const websitePreviewButton = document.querySelector('.website-preview-button');
const previewStartButton = document.querySelector('.preview-start');
websitePreviewButton?.addEventListener('click', () => {
  if (!window.ForgeOnboarding?.canPreview()) return;
  if (activeSite?.currentVersionId) {
    openPreview();
    return;
  }
  const unbuilt = document.querySelector('.preview-unbuilt');
  if (unbuilt && !unbuilt.hidden && !unbuilt.classList.contains('is-closing')) {
    if (menuLocked()) return;
    closeMenu();
    return;
  }
  openMenu('preview-unbuilt', websitePreviewButton);
});
previewStartButton?.addEventListener('click', () => {
  closeMenu();
  if (window.ForgeOnboarding?.enabled) {
    window.ForgeOnboarding.start().catch(error => showNote(composerError, messageOf(error)));
    return;
  }
  promptInput?.focus({preventScroll: true});
});

// The globe by the composer: where this site lives. The address under the
// hosting domain is the site's to choose, and a domain of their own is pointed
// at it with one record. Everything here is the account's, so it comes from
// Convex — the sheet carries no domain, price or example of its own.
const addressSheet = document.querySelector('.sheet.address');
const globeButton = document.querySelector('.globe-button');
const addressTablist = addressSheet?.querySelector('.address-tabs');
const addressTabs = addressSheet ? [...addressSheet.querySelectorAll('[role="tab"]')] : [];
function showAddressTab(name) {
  if (!addressSheet) return;
  const wanted = name === 'custom' ? 'custom' : 'address';
  addressTabs.forEach(tab => {
    const on = tab.dataset.tab === wanted;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  });
  addressSheet.querySelectorAll('[role="tabpanel"]').forEach(panel => {
    panel.hidden = panel.dataset.panel !== wanted;
  });
}
addressTablist?.addEventListener('click', event => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) showAddressTab(tab.dataset.tab);
});
addressTablist?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const current = addressTabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = addressTabs[(current + step + addressTabs.length) % addressTabs.length];
  if (!next) return;
  showAddressTab(next.dataset.tab);
  next.focus();
});
if (forge?.sites && addressSheet) {
  const slugForm = addressSheet.querySelector('.address-form');
  const slugField = slugForm.elements.slug;
  const saveButton = addressSheet.querySelector('.address-save');
  const suffix = addressSheet.querySelector('[data-address-domain]');
  const note = addressSheet.querySelector('[data-address-note]');
  const state = addressSheet.querySelector('[data-address-state]');
  const live = addressSheet.querySelector('[data-address-live]');
  const domainForm = addressSheet.querySelector('.address-domain-form');
  const gate = addressSheet.querySelector('.address-gate');
  const needsSlug = addressSheet.querySelector('.address-needs-slug');
  const siteBlock = addressSheet.querySelector('.address-site');
  const noSite = addressSheet.querySelector('.address-no-site');
  const tablist = addressTablist;
  const loading = addressSheet.querySelector('.address-loading');
  const domainList = addressSheet.querySelector('[data-address-domains]');
  const domainEmpty = addressSheet.querySelector('.address-empty');
  const error = addressSheet.querySelector('.address-error');
  const upsell = addressSheet.querySelector('.address-upsell');
  const addressBody = addressSheet.querySelector('.address-body');
  const warning = addressSheet.querySelector('.address-warning');
  const STATUS_LABELS = {pending: 'Pending', active: 'Active', failed: 'Failed'};
  let hosting = null;
  let accountDomains = [];
  // What the server would make of a name, so the field can suggest an address
  // before one has been taken. The server decides what is actually saved.
  function suggestSlug(name) {
    return (name ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, hosting?.maxLength ?? 40)
      .replace(/-+$/, '');
  }
  function siteDomains() {
    return activeSite ? accountDomains.filter(domain => domain.siteId === activeSite._id) : [];
  }
  function renderAddress() {
    // The globe is every member's, on every plan. An address is an
    // entitlement, so on a plan without one it opens the upsell and the way to
    // the plan screen rather than the picker -- which is how someone finds out
    // what it costs. Hiding the button instead just made it flash and vanish.
    if (globeButton) globeButton.hidden = false;
    // Until billing answers we do not know the plan, and guessing it is `free`
    // showed a paying member the upsell for what they already have -- briefly
    // on every load, and for good on a deployment whose summary never answers.
    const known = Boolean(summary);
    const addressable = Boolean(summary?.plan.publicAddress);
    const paid = catalog?.plans.find(plan => plan.publicAddress);
    if (loading) loading.hidden = known;
    if (upsell) upsell.hidden = !known || addressable;
    if (addressBody) addressBody.hidden = !known || !addressable;
    if (!known) return;
    if (!addressable) {
      const domainPlan = catalog?.plans.find(plan => plan.customDomains);
      // Everything named here comes from the catalog and the deployment's own
      // hosting, so this page carries no plan, price or domain of its own --
      // and reads as a whole sentence on each of them when they have not
      // answered yet, rather than leaving a blank where the sell was.
      setText('[data-address-upsell-example]', hosting?.domain
        ? `your-site.${hosting.domain}`
        : 'your-site');
      setText('[data-address-upsell-domain]', domainPlan
        ? `A domain you already own, on ${domainPlan.name}`
        : 'A domain you already own');
      setText('[data-address-upsell-price]', paid?.monthlyPriceCents
        ? ` from ${money(paid.monthlyPriceCents)}/mo`
        : '');
      return;
    }
    const hasSite = Boolean(activeSite);
    if (siteBlock) siteBlock.hidden = !hasSite;
    if (noSite) noSite.hidden = hasSite;
    if (tablist) tablist.hidden = !hasSite;
    if (!hasSite) return;
    if (suffix) suffix.textContent = hosting?.domain ? `.${hosting.domain}` : '';
    if (document.activeElement !== slugField) {
      slugField.value = activeSite.slug ?? '';
      slugField.placeholder = suggestSlug(activeSite.name) || 'your-site';
    }
    const address = activeSite.address;
    const canChangeAddress = activeSite.addressChangeAvailable !== false;
    const addressLocked = Boolean(activeSite.slug) && !canChangeAddress;
    live.hidden = !address;
    if (address) {
      live.href = address;
      live.textContent = address.replace(/^https?:\/\//, '');
    }
    if (state) {
      state.textContent = activeSite.slug
        ? activeSite.status === 'published' ? 'Live' : 'Reserved'
        : '';
      state.classList.toggle('is-active', activeSite.status === 'published');
    }
    slugField.disabled = addressLocked;
    slugForm.classList.toggle('is-locked', addressLocked);
    saveButton.textContent = activeSite.slug ? 'Change address' : 'Save address';
    // A site gets one move. Explain the consequence before it is spent, then
    // make the saved address visibly read-only once the server records it.
    if (warning) {
      warning.hidden = !activeSite.slug;
      warning.textContent = addressLocked
        ? 'This address has already been changed and cannot be changed again.'
        : 'You can change this address once. The old address will stop working.';
    }
    // Leave the line alone while it is answering what is being typed.
    if (document.activeElement !== slugField) {
      restingNote();
      saveButton.disabled = addressLocked;
    }
    // This section is one of three things and never none of them. It used to
    // wait on the catalog to name the plan it was selling, and a plan without
    // domains plus a catalog that had not answered hid the form and the upsell
    // together -- leaving the heading standing over nothing at all.
    const allowed = Boolean(summary?.plan.customDomains);
    const cheapest = catalog?.plans.find(plan => plan.customDomains);
    const hasSlug = Boolean(activeSite.slug);
    setText('[data-address-plan]', cheapest?.name ? `the ${cheapest.name} plan` : 'a higher plan');
    // Name the plan being read, so a plan that is not what it should be is
    // visible here rather than only in what the sheet refuses to show.
    setText('[data-address-current-plan]', summary?.plan?.name ? ` — you're on ${summary.plan.name}` : '');
    domainForm.hidden = !allowed || !hasSlug;
    if (needsSlug) needsSlug.hidden = !allowed || hasSlug;
    gate.hidden = allowed;
    renderDomainRows();
  }
  function restingNote(text = null, kind = null) {
    note.textContent = text ?? (!activeSite?.slug
      ? 'Pick an address. It is saved now and used the moment you publish.'
      : activeSite.status === 'published'
        ? 'Live at this address.'
        : 'Reserved for this site. Publish to put the latest build on it.');
    note.classList.toggle('is-free', kind === 'free');
    note.classList.toggle('is-taken', kind === 'taken');
  }
  // The address field answers as it is typed, from the same rules that decide
  // the save: length, shape, the reserved list and whether it is already
  // someone's. Only the server ever grants one -- this is the field saying
  // what it already knows, so a name is not lost to a round trip to find out.
  let slugTicket = 0;
  let slugTimer = null;
  async function checkSlug() {
    const ticket = ++slugTicket;
    if (!activeSite || slugField.disabled) return;
    const wanted = slugField.value.trim();
    if (!wanted || wanted === (activeSite.slug ?? '')) {
      saveButton.disabled = false;
      restingNote();
      return;
    }
    let answer = null;
    try {
      answer = await forge.sites.slugAvailable(wanted, activeSite._id);
    } catch {
      /* The save still asks the server properly; this line is a convenience. */
    }
    if (ticket !== slugTicket || !answer) return;
    saveButton.disabled = !answer.available;
    if (answer.available) restingNote(`${answer.host ?? answer.slug} is free.`, 'free');
    else restingNote(answer.problem ?? 'That address is taken. Try another one.', 'taken');
  }
  // One record, laid out the way a registrar asks for it.
  function recordNode(domain) {
    const record = domain.record;
    if (!record?.value) {
      const waiting = document.createElement('small');
      waiting.className = 'address-said';
      waiting.textContent = 'Give the site an address first, then point this domain at it.';
      return waiting;
    }
    const list = document.createElement('dl');
    list.className = 'address-record';
    for (const [label, value] of [['Type', record.type], ['Name', record.name], ['Value', record.value]]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      list.append(term, detail);
    }
    return list;
  }
  function renderDomainRows() {
    const rows = siteDomains();
    const allowed = Boolean(summary?.plan.customDomains);
    domainEmpty.hidden = rows.length > 0 || !allowed || !activeSite?.slug;
    domainList.hidden = rows.length === 0;
    domainList.replaceChildren(...rows.map(domain => {
      const row = document.createElement('div');
      row.className = 'address-domain';
      const head = document.createElement('div');
      head.className = 'address-domain-head';
      const host = document.createElement('strong');
      host.textContent = domain.hostname;
      const status = document.createElement('span');
      status.className = `status-chip is-${domain.status}`;
      status.textContent = STATUS_LABELS[domain.status] ?? domain.status;
      head.append(host, status);
      row.append(head, recordNode(domain));
      if (domain.note) {
        const said = document.createElement('small');
        said.className = 'address-said';
        said.textContent = domain.note;
        row.append(said);
      }
      const actions = document.createElement('div');
      actions.className = 'address-domain-actions';
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.className = 'chip-button is-quiet';
      verify.textContent = domain.status === 'active' ? 'Check again' : 'Verify';
      verify.addEventListener('click', async () => {
        showNote(error, '');
        verify.disabled = true;
        verify.textContent = 'Checking…';
        try {
          await forge.domains.verify(domain._id);
        } catch (caught) {
          reportError(caught);
          showNote(error, messageOf(caught));
        } finally {
          verify.disabled = false;
          renderDomainRows();
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link-button address-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${domain.hostname}?`)) return;
        showNote(error, '');
        forge.domains.remove(domain._id).catch(caught => showNote(error, messageOf(caught)));
      });
      actions.append(verify, remove);
      row.append(actions);
      return row;
    }));
  }
  slugField.addEventListener('input', () => {
    clearTimeout(slugTimer);
    slugTimer = setTimeout(checkSlug, 250);
  });
  // Only drop the pending check. Re-rendering here would put the saved slug
  // back in the field -- and pressing Save blurs it first, so the submit below
  // would read the old name instead of the typed one. The next subscription
  // tick settles the field, as it always did.
  slugField.addEventListener('blur', () => { clearTimeout(slugTimer); });
  slugForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeSite || slugField.disabled || saveButton.disabled) return;
    const wanted = slugField.value.trim() || slugField.placeholder;
    showNote(error, '');
    saveButton.disabled = true;
    try {
      await forge.sites.setSlug(activeSite._id, wanted);
      slugField.blur();
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
    } finally {
      saveButton.disabled = slugField.disabled;
    }
  });
  domainForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeSite) return;
    const submit = domainForm.querySelector('.chip-button');
    if (submit.disabled) return;
    showNote(error, '');
    submit.disabled = true;
    try {
      await forge.domains.add(activeSite._id, domainForm.elements.hostname.value);
      domainForm.elements.hostname.value = '';
    } catch (caught) {
      reportError(caught);
      showNote(error, messageOf(caught));
    } finally {
      submit.disabled = false;
    }
  });
  addressSheet.querySelectorAll('.open-plan-from-address').forEach(button => {
    button.addEventListener('click', () => {
      if (addressSheet && !addressSheet.hidden) hideOverlay(addressSheet, {keepDim: true});
      openMenu('navigation');
      showSettings(true);
      showSettingsScreen('plan');
    });
  });
  forge.sites.hosting?.(next => { hosting = next ?? null; renderAddress(); });
  forge.domains?.subscribe(next => {
    accountDomains = Array.isArray(next) ? next : [];
    renderAddress();
  });
  document.addEventListener('forge:active-site', renderAddress);
  document.addEventListener('forge:sites', renderAddress);
  document.addEventListener('forge:billing', renderAddress);
  renderAddress();
}

// Review framing for the settings screens, once their wiring exists.
if (['profile', 'plan', 'usage', 'domains'].includes(query.get('screen'))) {
  openMenu('navigation');
  showSettings(true);
  showSettingsScreen(query.get('screen'));
}
if (query.get('screen') === 'preview') openPreview();
document.addEventListener('forge:choose-plan', () => {
  openMenu('navigation');
  showSettings(true);
  showSettingsScreen('plan');
});
