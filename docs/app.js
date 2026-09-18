// Menus, appearance, and voice input are local; conversations persist through ForgeData (Convex).
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
const backdrop = document.querySelector('.backdrop');
const appearance = document.querySelector('.appearance');
// Full-screen overlays sit above the drawer and are driven by their own back
// buttons rather than the sheet machinery, so they stay out of `panels`.
const overlays = [appearance, ...document.querySelectorAll('.overlay')].filter(Boolean);
const panels = [...document.querySelectorAll('[role="dialog"]')].filter(panel => !overlays.includes(panel));
const navigation = document.querySelector('.navigation');
const historyContent = document.querySelector('.nav-content');
const settingsContent = document.querySelector('.settings-content');
// iOS 26 standalone reports a zero top inset even though it reserves the strip,
// so fall back to the gap the system withheld from the web layer.
function measureStatusStrip() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)';
  document.body.append(probe);
  const inset = probe.getBoundingClientRect().height;
  probe.remove();
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const withheld = (window.screen?.height || 0) - window.innerHeight;
  const strip = inset > 0 ? inset : (standalone && withheld > 0 && withheld <= 80 ? withheld : 0);
  document.documentElement.style.setProperty('--status-strip', `${strip}px`);
}
measureStatusStrip();
window.addEventListener('resize', measureStatusStrip);
window.addEventListener('orientationchange', measureStatusStrip);

let themeColor = document.querySelector('meta[name="theme-color"]');
// iOS caches the standalone status-bar tint and ignores in-place edits to the
// existing tag, so replace the element to make it re-read the app background.
function refreshStatusBarTint() {
  const tint = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
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
  document.querySelectorAll('.theme-select,.font-select,.conversation-options,.row-options').forEach(button => button.setAttribute('aria-expanded', 'false'));
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
function resetViewport() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}
function hideOverlay(element) {
  if (!element) return;
  element.hidden = true;
  element.classList.remove('is-open');
  element.scrollTop = 0;
}
function closeMenu() {
  closePopovers();
  const active = document.activeElement;
  if (active && app.contains(active) && active !== document.body) active.blur();
  closeOverlays();
  panels.forEach(hideOverlay);
  hideOverlay(backdrop);
  app.classList.remove('navigation-open', 'sheet-open');
  document.querySelectorAll('[data-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  resetViewport();
  requestAnimationFrame(() => {
    resetViewport();
    app.style.transform = 'translateZ(0)';
    void app.offsetHeight;
    app.style.transform = '';
    refreshStatusBarTint();
    opener?.focus({preventScroll:true});
  });
}
function openMenu(name, trigger) {
  closeMenu();
  const panel = document.querySelector(`.${name}`);
  if (!panels.includes(panel)) return;
  opener = trigger;
  if (name === 'navigation') showSettings(false);
  panel.hidden = false;
  panel.classList.add('is-open');
  backdrop.hidden = false;
  backdrop.classList.add('is-open');
  app.classList.add('sheet-open');
  app.classList.toggle('navigation-open', name === 'navigation');
  trigger?.setAttribute('aria-expanded', 'true');
  panel.querySelector('button')?.focus({preventScroll:true});
  resetViewport();
}
document.querySelectorAll('[data-open]').forEach(button => {
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const panel = document.querySelector(`.${button.dataset.open}`);
    if (!panel.hidden) closeMenu(); else openMenu(button.dataset.open, button);
  });
});
document.querySelectorAll('.dismiss').forEach(button => button.addEventListener('click', closeMenu));
document.querySelectorAll('[data-sheet-back]').forEach(button => {
  button.addEventListener('click', () => openMenu(button.dataset.sheetBack));
});
backdrop.addEventListener('click', closeMenu);
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
if (['connections','cloud-picker','repo-picker','models','attachments','account','navigation'].includes(query.get('screen'))) openMenu(query.get('screen'));
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

// Conversations and the account persist in Convex through the ForgeData bundle loaded before this script.
const forge = window.ForgeData;
function reportError(error) {
  console.error('Forge Nexxus could not save the change', error);
}
const conversationList = document.querySelector('.conversation-list');
const newChat = document.querySelector('.new-chat');
const thread = document.querySelector('.thread');
if (forge?.conversations && conversationList && thread) {
  let conversations = [];
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
  function renderConversations() {
    conversationList.replaceChildren(...conversations.map(conversation => {
      const active = conversation._id === activeId;
      const row = document.createElement('div');
      row.className = 'conversation';
      row.classList.toggle('is-active', active);
      const dot = document.createElement('span');
      dot.className = 'conversation-dot';
      dot.setAttribute('aria-hidden', 'true');
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'conversation-title';
      title.textContent = conversation.title;
      title.setAttribute('aria-current', String(active));
      title.addEventListener('click', () => { selectConversation(conversation._id); closeMenu(); });
      const options = document.createElement('button');
      options.type = 'button';
      options.className = 'conversation-options';
      options.setAttribute('aria-label', `Options for ${conversation.title}`);
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'false');
      options.append(optionsIcon());
      const menu = document.createElement('div');
      menu.className = 'font-menu conversation-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      menu.append(
        menuItem('Rename', () => {
          const next = prompt('Rename conversation', conversation.title)?.trim();
          if (next && next !== conversation.title) forge.conversations.rename(conversation._id, next).catch(reportError);
        }),
        menuItem('Delete', () => {
          if (confirm(`Delete "${conversation.title}"?`)) forge.conversations.remove(conversation._id).catch(reportError);
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
      const body = document.createElement('p');
      body.textContent = message.body;
      row.append(body);
      return row;
    }));
    app.classList.toggle('has-thread', messages.length > 0);
    thread.scrollTop = thread.scrollHeight;
  }
  function selectConversation(id) {
    stopMessages?.();
    stopMessages = null;
    rememberActive(id);
    renderConversations();
    if (!id) { renderThread([]); return; }
    stopMessages = forge.messages.subscribe(id, renderThread);
  }
  forge.conversations.subscribe(list => {
    conversations = list;
    const activeGone = activeId && forge.auth.state().signedIn && !list.some(conversation => conversation._id === activeId);
    if (activeGone) selectConversation(null);
    else renderConversations();
  });
  if (activeId) selectConversation(activeId);

  newChat?.addEventListener('click', () => {
    forge.conversations.create().then(id => {
      selectConversation(id);
      closeMenu();
      promptInput?.focus({preventScroll:true});
    }).catch(reportError);
  });

  async function sendPrompt() {
    const body = promptInput.value.trim();
    if (!body) return;
    promptInput.value = '';
    try {
      let id = activeId;
      if (!id || !conversations.some(conversation => conversation._id === id)) {
        id = await forge.conversations.create(body.length > 48 ? `${body.slice(0, 47).trimEnd()}…` : body);
        selectConversation(id);
      }
      await forge.messages.send(id, body);
    } catch (error) {
      promptInput.value = body;
      reportError(error);
    }
  }
  promptInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendPrompt();
    }
  });
}

// Set by the Remote Workspaces block below. Adding a server needs a host, a
// username and a credential, so the Connect sheet hands that off rather than
// keeping a second, weaker form.
let startWorkspaceWizard = null;

// The Connect sheet reads from two places, because a repository and a server
// are not the same thing: repos come from `connections`, and Cloud is the
// remote workspaces saved in Settings, so connecting one shows up in both.
// Nothing is seeded, so a user who has added nothing sees empty lists.
const connectionsSheet = document.querySelector('.connections');
if (connectionsSheet) {
  const recentsSection = connectionsSheet.querySelector('.recents-section');
  const recents = connectionsSheet.querySelector('.recents');
  const pickerLists = [...document.querySelectorAll('[data-list]')];
  const filterInputs = [...document.querySelectorAll('[data-filter]')];
  const EMPTY_COPY = {
    cloud: 'No servers added yet.',
    repo: 'No repositories connected yet.',
  };
  const filters = {};
  const connectButton = document.querySelector('.composer-area .connect');
  const reasonOf = error => error?.data ?? error?.message ?? 'Something went wrong';
  let connections = [];
  let servers = [];
  let connecting = null;

  // A workspace is drawn with the same row as a repo, so it is reshaped rather
  // than given a second renderer.
  function asRow(workspace) {
    return {
      _id: workspace._id,
      kind: 'cloud',
      remote: true,
      name: workspace.name,
      detail: `${workspace.username}@${workspace.host}`,
      connected: workspace.connected,
      usedAt: workspace.lastConnectedAt ?? workspace.createdAt ?? 0,
    };
  }
  function everything() {
    return [...connections.filter(connection => connection.kind === 'repo'), ...servers];
  }

  function fail(kind, message, error) {
    if (error) reportError(error);
    const slot = document.querySelector(`[data-error="${kind}"]`);
    if (!slot) return;
    slot.textContent = message;
    slot.hidden = false;
  }
  function clearError(kind) {
    const slot = document.querySelector(`[data-error="${kind}"]`);
    if (!slot) return;
    slot.textContent = '';
    slot.hidden = true;
  }

  function matches(connection, term) {
    const needle = term.trim().toLowerCase();
    if (!needle) return true;
    return connection.name.toLowerCase().includes(needle)
      || connection.detail.toLowerCase().includes(needle);
  }
  // Cloud rows carry a Connect/Connected status; a repo row only says so once
  // it is the active one, which is how the two lists are drawn.
  function workspaceRow(connection, showStatus) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'workspace';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    glyph.setAttribute('href', connection.kind === 'repo' ? '#branch' : '#server');
    icon.append(glyph);
    const copy = document.createElement('span');
    copy.className = 'workspace-copy';
    const name = document.createElement('strong');
    name.textContent = connection.name;
    const detail = document.createElement('small');
    detail.textContent = connection.detail;
    copy.append(name, detail);
    row.append(icon, copy);
    const busy = connecting === connection._id;
    if (showStatus || connection.connected || busy) {
      const status = document.createElement('span');
      status.className = connection.connected ? 'status active' : 'status';
      status.textContent = busy ? 'Connecting…' : connection.connected ? 'Connected' : 'Connect';
      row.append(status);
    }
    if (busy) row.setAttribute('aria-disabled', 'true');
    row.setAttribute(
      'aria-label',
      `${connection.connected ? 'Disconnect from' : 'Connect to'} ${connection.name}`
    );
    row.addEventListener('click', () => {
      if (connecting) return;
      const connect = !connection.connected;
      const fromPicker = Boolean(row.closest('.picker'));
      clearError(connection.kind);
      if (connection.remote) {
        void toggleServer(connection, connect, fromPicker);
        return;
      }
      forge.connections.setConnected(connection._id, connect)
        .catch(error => fail(connection.kind, 'Could not change that connection.', error));
      // Picking a workspace in a picker is the end of that errand, so the sheet
      // returns to Connect where the new state shows up under Recents.
      if (connect && fromPicker) openMenu('connections');
    });
    return row;
  }
  function optionsGlyph() {
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
  // Only the pickers manage workspaces; Recents on the Connect sheet stays a
  // plain list of rows.
  function manageableRow(connection, row) {
    const wrapper = document.createElement('div');
    wrapper.className = 'workspace-row';
    const options = document.createElement('button');
    options.type = 'button';
    options.className = 'row-options';
    options.setAttribute('aria-label', `Options for ${connection.name}`);
    options.setAttribute('aria-haspopup', 'menu');
    options.setAttribute('aria-expanded', 'false');
    options.append(optionsGlyph());
    const menu = document.createElement('div');
    menu.className = 'font-menu row-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.append(
      menuItem('Rename', () => {
        const next = prompt('Rename workspace', connection.name)?.trim();
        if (!next || next === connection.name) return;
        clearError(connection.kind);
        forge.connections.rename(connection._id, next)
          .catch(error => fail(connection.kind, 'Could not rename that workspace.', error));
      }),
      menuItem('Remove', () => {
        if (!confirm(`Remove "${connection.name}"?`)) return;
        clearError(connection.kind);
        forge.connections.remove(connection._id)
          .catch(error => fail(connection.kind, 'Could not remove that workspace.', error));
      })
    );
    options.addEventListener('click', event => {
      event.stopPropagation();
      const open = menu.hidden;
      closePopovers();
      menu.hidden = !open;
      options.setAttribute('aria-expanded', String(open));
    });
    wrapper.append(row, options, menu);
    return wrapper;
  }
  // Disconnecting is local state; connecting opens a session against the real
  // server, which takes long enough to need a visible pending state.
  async function toggleServer(server, connect, fromPicker) {
    if (!connect) {
      forge.workspaces.disconnect(server._id)
        .catch(error => fail('cloud', 'Could not disconnect that server.', error));
      return;
    }
    connecting = server._id;
    render();
    try {
      const outcome = await forge.workspaces.connect(server._id);
      if (!outcome?.ok) fail('cloud', outcome?.message ?? 'Could not reach that server.');
      else if (fromPicker) openMenu('connections');
    } catch (error) {
      fail('cloud', reasonOf(error), error);
    } finally {
      connecting = null;
      render();
    }
  }
  function render() {
    const rows = everything();
    const term = filters.recents ?? '';
    const recent = [...rows]
      .sort((a, b) => b.usedAt - a.usedAt)
      .filter(connection => matches(connection, term));
    recents.replaceChildren(...recent.map(connection => workspaceRow(connection, true)));
    recentsSection.hidden = recent.length === 0;
    pickerLists.forEach(list => {
      const kind = list.dataset.list;
      const search = filters[kind] ?? '';
      const ofKind = rows.filter(connection => connection.kind === kind);
      const shown = ofKind
        .filter(connection => matches(connection, search))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Servers are managed in Settings, so only repo rows carry the options menu.
      list.replaceChildren(...shown.map(connection => {
        const row = workspaceRow(connection, kind === 'cloud');
        return connection.remote ? row : manageableRow(connection, row);
      }));
      const empty = document.querySelector(`[data-empty="${kind}"]`);
      if (!empty) return;
      empty.textContent = ofKind.length === 0 ? EMPTY_COPY[kind] : 'No workspaces match that search.';
      empty.hidden = shown.length > 0;
    });
    // The composer's pill reports the session's state at a glance: Connected
    // once any workspace is active, Connect while none is.
    const active = rows.find(connection => connection.connected);
    if (connectButton) {
      connectButton.textContent = active ? 'Connected' : 'Connect';
      connectButton.setAttribute(
        'aria-label',
        active ? `Connected to ${active.name}. Open connections` : 'Connect a workspace'
      );
    }
    document.querySelectorAll('[data-count]').forEach(count => {
      const total = rows.filter(connection => connection.kind === count.dataset.count).length;
      count.textContent = total ? String(total) : '';
      count.hidden = total === 0;
    });
  }
  filterInputs.forEach(input => {
    filters[input.dataset.filter] = '';
    input.addEventListener('input', () => {
      filters[input.dataset.filter] = input.value;
      render();
    });
  });
  function showAddForm(kind, show) {
    const form = document.querySelector(`[data-form="${kind}"]`);
    const trigger = document.querySelector(`[data-add="${kind}"]`);
    if (!form || !trigger) return;
    form.hidden = !show;
    trigger.closest('.picker-actions').hidden = show;
    trigger.setAttribute('aria-expanded', String(show));
    if (show) form.querySelector('input')?.focus({preventScroll:true});
    else form.reset();
  }
  document.querySelectorAll('[data-add]').forEach(trigger => {
    trigger.addEventListener('click', () => showAddForm(trigger.dataset.add, true));
  });
  document.querySelectorAll('[data-cancel]').forEach(button => {
    button.addEventListener('click', () => showAddForm(button.dataset.cancel, false));
  });
  document.querySelectorAll('[data-form]').forEach(form => {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const kind = form.dataset.form;
      const name = form.elements.name.value.trim();
      const detail = form.elements.detail.value.trim();
      const submit = form.querySelector('[type="submit"]');
      if (!name || !detail || submit.disabled) return;
      submit.disabled = true;
      clearError(kind);
      try {
        await forge.connections.add(kind, name, detail);
        showAddForm(kind, false);
      } catch (error) {
        fail(kind, 'Could not add that workspace. Check the name and address.', error);
      } finally {
        submit.disabled = false;
      }
    });
  });
  // Every sheet opens on a clean search and a collapsed form, the same way it
  // opens scrolled to top.
  function resetSheets() {
    let changed = false;
    filterInputs.forEach(input => {
      if (input.value === '') return;
      input.value = '';
      filters[input.dataset.filter] = '';
      changed = true;
    });
    document.querySelectorAll('[data-add]').forEach(trigger => {
      showAddForm(trigger.dataset.add, false);
      clearError(trigger.dataset.add);
    });
    if (changed) render();
  }
  document.querySelectorAll('[data-wizard]').forEach(button => {
    button.addEventListener('click', () => {
      closeMenu();
      startWorkspaceWizard?.();
    });
  });
  document.querySelectorAll('[data-open],[data-sheet-back],.dismiss')
    .forEach(button => button.addEventListener('click', resetSheets));
  backdrop.addEventListener('click', resetSheets);
  render();
  forge?.connections?.subscribe(list => {
    connections = Array.isArray(list) ? list : [];
    render();
  });
  forge?.workspaces?.subscribe(list => {
    servers = (Array.isArray(list) ? list : []).map(asRow);
    render();
  });
}

const accountSheet = document.querySelector('.account');
if (forge?.account && accountSheet) {
  const guestView = accountSheet.querySelector('.account-guest');
  const memberView = accountSheet.querySelector('.account-member');
  const emailForm = accountSheet.querySelector('.account-email');
  const emailSent = accountSheet.querySelector('.account-sent');
  const labels = document.querySelectorAll('[data-account-label]');
  const avatars = document.querySelectorAll('[data-account-avatar]');
  function renderAccount(user) {
    const member = user && !user.isAnonymous;
    guestView.hidden = Boolean(member);
    memberView.hidden = !member;
    const name = member ? (user.name || user.email || 'Signed in') : 'Guest';
    labels.forEach(label => { label.textContent = name; });
    avatars.forEach(avatar => { avatar.textContent = name.trim().charAt(0).toUpperCase() || 'G'; });
    accountSheet.querySelector('[data-account-name]').textContent = member ? name : '';
    accountSheet.querySelector('[data-account-email]').textContent = member && user.email && user.email !== name ? user.email : '';
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
  accountSheet.querySelector('.account-signout').addEventListener('click', () => {
    forge.auth.signOut().then(closeMenu).catch(reportError);
  });
}

// Remote Workspaces: real servers saved against the account. The credential is
// handed to Convex once and never comes back, so what is rendered here is
// metadata plus whatever the last handshake reported.
const workspacesScreen = document.querySelector('.workspaces');
const wizardScreen = document.querySelector('.workspace-wizard');
if (workspacesScreen && wizardScreen) {
  const cards = workspacesScreen.querySelector('.workspace-cards');
  const emptyNote = workspacesScreen.querySelector('.workspaces-empty');
  const listError = workspacesScreen.querySelector('.workspaces-error');
  const openEntry = document.querySelector('.open-workspaces');
  const wizardForm = wizardScreen.querySelector('.wizard-form');
  const typeStep = wizardScreen.querySelector('[data-step="type"]');
  const detailsTitle = wizardScreen.querySelector('[data-details-title]');
  const passwordLabel = wizardScreen.querySelector('[data-password-label]');
  const passwordHint = wizardScreen.querySelector('[data-password-hint]');
  const keyFields = wizardScreen.querySelector('[data-auth="key"]');
  const result = wizardScreen.querySelector('.wizard-result');
  const testButton = wizardScreen.querySelector('.test-button');
  const createButton = wizardScreen.querySelector('.wizard-create');
  const wizardScroll = wizardScreen.querySelector('.appearance-scroll');
  const ENVIRONMENTS = {production: 'Production', staging: 'Staging', dev: 'Dev'};
  const field = name => wizardForm.querySelector(`[name="${name}"]`);
  let workspaces = [];
  let protocol = 'ssh';
  let connecting = null;

  function glyph(id, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (className) svg.setAttribute('class', className);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }
  // A ConvexError arrives with its message on `data`; anything else is a
  // transport failure worth reporting in the same place.
  function messageOf(error) {
    reportError(error);
    return error?.data ?? error?.message ?? 'Something went wrong';
  }
  function showListError(message) {
    listError.textContent = message ?? '';
    listError.hidden = !message;
  }
  function optionsFor(workspace) {
    const options = document.createElement('button');
    options.type = 'button';
    options.className = 'row-options';
    options.setAttribute('aria-label', `Options for ${workspace.name}`);
    options.setAttribute('aria-haspopup', 'menu');
    options.setAttribute('aria-expanded', 'false');
    const dots = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dots.setAttribute('viewBox', '0 0 24 24');
    dots.setAttribute('aria-hidden', 'true');
    for (const cy of [6, 12, 18]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', 12);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', 1.25);
      dots.append(dot);
    }
    options.append(dots);
    const menu = document.createElement('div');
    menu.className = 'font-menu row-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const item = (label, action) => {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('role', 'menuitem');
      entry.textContent = label;
      entry.addEventListener('click', () => { closePopovers(); action(); });
      return entry;
    };
    menu.append(
      item('Rename', () => {
        const next = prompt('Rename workspace', workspace.name)?.trim();
        if (!next || next === workspace.name) return;
        showListError(null);
        forge.workspaces.rename(workspace._id, next).catch(error => showListError(messageOf(error)));
      }),
      item('Remove', () => {
        if (!confirm(`Remove "${workspace.name}"? Its stored credentials are deleted too.`)) return;
        showListError(null);
        forge.workspaces.remove(workspace._id).catch(error => showListError(messageOf(error)));
      })
    );
    options.addEventListener('click', event => {
      event.stopPropagation();
      const open = menu.hidden;
      closePopovers();
      menu.hidden = !open;
      options.setAttribute('aria-expanded', String(open));
    });
    return [options, menu];
  }
  function workspaceCard(workspace) {
    const article = document.createElement('article');
    article.className = 'workspace-card';
    article.classList.toggle('is-connected', workspace.connected);

    const head = document.createElement('div');
    head.className = 'workspace-card-head';
    const badge = document.createElement('span');
    badge.className = 'workspace-badge';
    badge.append(glyph('server'));
    const copy = document.createElement('div');
    copy.className = 'workspace-card-copy';
    const name = document.createElement('strong');
    name.textContent = workspace.name;
    const address = document.createElement('code');
    address.textContent = `${workspace.username}@${workspace.host}:${workspace.port}`;
    copy.append(name, address);
    head.append(badge, copy, ...optionsFor(workspace));

    const meta = document.createElement('div');
    meta.className = 'workspace-meta';
    const state = document.createElement('span');
    state.className = 'workspace-state';
    if (workspace.connected) {
      const dot = document.createElement('span');
      dot.className = 'state-dot';
      state.append(dot, document.createTextNode('Connected'));
    } else {
      state.append(glyph('wifi-off'), document.createTextNode('Disconnected'));
    }
    const protocolChip = document.createElement('span');
    protocolChip.className = 'chip protocol';
    protocolChip.append(
      glyph(workspace.protocol === 'sftp' ? 'folder' : 'terminal'),
      document.createTextNode(workspace.protocol.toUpperCase())
    );
    meta.append(state, protocolChip);
    if (workspace.environment) {
      const tag = document.createElement('span');
      tag.className = `chip env-${workspace.environment}`;
      tag.textContent = ENVIRONMENTS[workspace.environment];
      meta.append(tag);
    }

    const action = document.createElement('button');
    action.type = 'button';
    action.className = workspace.connected ? 'workspace-action is-secondary' : 'workspace-action';
    const working = connecting === workspace._id;
    action.disabled = working;
    if (working) action.textContent = 'Connecting…';
    else action.append(
      glyph(workspace.connected ? 'wifi-off' : 'wifi'),
      document.createTextNode(workspace.connected ? 'Disconnect' : 'Connect')
    );
    action.addEventListener('click', () => toggleConnection(workspace));

    article.append(head, meta, action);
    if (workspace.lastError && !workspace.connected) {
      const note = document.createElement('p');
      note.className = 'workspaces-error';
      note.textContent = workspace.lastError;
      article.append(note);
    }
    return article;
  }
  function renderWorkspaces() {
    cards.replaceChildren(...workspaces.map(workspaceCard));
    emptyNote.hidden = workspaces.length > 0;
  }
  async function toggleConnection(workspace) {
    showListError(null);
    if (workspace.connected) {
      forge.workspaces.disconnect(workspace._id).catch(error => showListError(messageOf(error)));
      return;
    }
    connecting = workspace._id;
    renderWorkspaces();
    try {
      const outcome = await forge.workspaces.connect(workspace._id);
      if (!outcome?.ok) showListError(outcome?.message ?? 'Could not reach that server');
    } catch (error) {
      showListError(messageOf(error));
    } finally {
      connecting = null;
      renderWorkspaces();
    }
  }
  function setResult(message, ok) {
    result.textContent = message ?? '';
    result.hidden = !message;
    result.classList.toggle('is-ok', ok === true);
    result.classList.toggle('is-bad', ok === false);
  }
  function setProtocol(next) {
    protocol = next === 'sftp' ? 'sftp' : 'ssh';
    detailsTitle.textContent = `Connection Details (${protocol.toUpperCase()})`;
    keyFields.hidden = protocol !== 'ssh';
    const password = field('password');
    password.placeholder = protocol === 'sftp' ? 'Enter SFTP password' : 'Enter SSH password';
    password.required = protocol === 'sftp';
    passwordLabel.textContent = 'Password';
    if (protocol === 'sftp') {
      const star = document.createElement('i');
      star.textContent = '*';
      passwordLabel.append(' ', star);
    }
    passwordHint.textContent = protocol === 'sftp'
      ? 'Password for SFTP authentication'
      : 'Less secure than key-based authentication';
    wizardScreen.querySelectorAll('.type-card').forEach(card => {
      card.setAttribute('aria-pressed', String(card.dataset.protocol === protocol));
    });
  }
  function showStep(step) {
    typeStep.hidden = step !== 'type';
    wizardForm.hidden = step !== 'details';
    if (wizardScroll) wizardScroll.scrollTop = 0;
  }
  function openWorkspaces() {
    showListError(null);
    showOverlay(workspacesScreen);
    navigation.setAttribute('aria-label', 'Remote workspaces');
  }
  function openWizard() {
    wizardForm.reset();
    wizardForm.classList.remove('is-collapsed');
    wizardScreen.querySelector('.section-toggle').setAttribute('aria-expanded', 'true');
    setResult(null);
    setProtocol('ssh');
    showStep('type');
    showOverlay(wizardScreen);
    navigation.setAttribute('aria-label', 'New remote workspace');
  }
  // Only the parts the chosen protocol actually uses are sent, so an SFTP
  // workspace never carries an SSH key it ignored.
  function credentials() {
    const key = protocol === 'ssh' ? field('privateKey').value.trim() : '';
    const passphrase = protocol === 'ssh' ? field('passphrase').value : '';
    const password = field('password').value;
    return {
      ...(key ? {privateKey: key} : {}),
      ...(key && passphrase ? {passphrase} : {}),
      ...(password ? {password} : {}),
    };
  }
  function target() {
    return {
      protocol,
      host: field('host').value.trim(),
      port: Number(field('port').value),
      username: field('username').value.trim(),
    };
  }

  openEntry?.addEventListener('click', openWorkspaces);
  workspacesScreen.querySelector('.workspaces-back').addEventListener('click', () => {
    showSettings(true);
    openEntry?.focus({preventScroll:true});
  });
  workspacesScreen.querySelector('.new-workspace').addEventListener('click', openWizard);
  wizardScreen.querySelector('.wizard-back').addEventListener('click', () => {
    if (!wizardForm.hidden) { showStep('type'); return; }
    openWorkspaces();
  });
  wizardScreen.querySelector('.wizard-prev').addEventListener('click', () => showStep('type'));
  wizardScreen.querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => {
      setProtocol(card.dataset.protocol);
      showStep('details');
    });
  });
  wizardScreen.querySelector('.section-toggle').addEventListener('click', event => {
    event.preventDefault();
    const collapsed = wizardForm.classList.toggle('is-collapsed');
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  });
  testButton.addEventListener('click', async () => {
    setResult('Testing the connection…');
    testButton.disabled = true;
    try {
      const outcome = await forge.workspaces.test({...target(), ...credentials()});
      setResult(outcome.message, outcome.ok);
    } catch (error) {
      setResult(messageOf(error), false);
    } finally {
      testButton.disabled = false;
    }
  });
  wizardForm.addEventListener('submit', async event => {
    event.preventDefault();
    createButton.disabled = true;
    setResult('Saving the workspace…');
    try {
      await forge.workspaces.create({
        name: field('name').value.trim(),
        environment: field('environment').value || undefined,
        ...target(),
        ...credentials(),
      });
      setResult(null);
      openWorkspaces();
    } catch (error) {
      setResult(messageOf(error), false);
    } finally {
      createButton.disabled = false;
    }
  });

  startWorkspaceWizard = openWizard;
  renderWorkspaces();
  forge?.workspaces?.subscribe(list => {
    workspaces = Array.isArray(list) ? list : [];
    renderWorkspaces();
  });
}
