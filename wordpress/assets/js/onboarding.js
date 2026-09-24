// One full-screen route owns access to the app. The server decides whether a
// paid member has a built website; local flags and URL parameters never do.
// ENABLED is the one switch for the website-setup route. The server never
// traps anyone in it: a failed build can always be left for the dashboard.
const ENABLED = true;
(() => {
  const data = window.ForgeData;
  const questions = data?.onboardingQuestions ?? [];
  // The last question is where Build sits. Read it from the list so adding a
  // question moves the button rather than stranding it mid-way.
  const lastStep = () => questions.length - 1;
  const screen = document.querySelector('#site-onboarding');
  const dashboard = document.querySelector('main.app');
  const checkout = new URL(location.href).searchParams.get('checkout');
  let awaitingPayment = checkout === 'success' || Boolean(window.forgePaymentPending);
  let member = null;
  let state = null;
  let subscriptionError = false;
  let starting = false;
  let busy = false;
  let activeDraft = null;
  let step = 0;
  let rendered = '';
  let saveTimer;
  let saveQueue = Promise.resolve();
  let offline = !navigator.onLine;
  // What the hand-off shows about the finished site: whether it is live, and
  // the address Forge gave it. It comes from Convex, like everything else.
  let sitesList = [];
  let trace = null;
  // A build only ever runs on the server. When the deployment does not have
  // the function a press needs, the press says so instead of doing something
  // else: a rebuild that edits the old page is not a rebuild.
  function notDeployed(error, name) {
    const text = String(error?.data || error?.message || '');
    return /Could not find public function/i.test(text)
      ? `${name} isn’t on this deployment yet. Deploy the latest Convex functions, then try again.`
      : null;
  }
  function currentDraft() {
    return state?.draft ?? null;
  }
  function belongsToDraft(draft) {
    const latest = trace?.latest;
    if (!latest) return false;
    if (latest.onboardingId && draft.id === latest.onboardingId) return true;
    return Boolean(latest.siteId && draft.siteId && latest.siteId === draft.siteId);
  }
  function progressEvents(draft) {
    const extras = belongsToDraft(draft) ? (trace?.events ?? []) : [];
    const seen = new Set();
    const rows = [];
    for (const event of [...(draft.events ?? []), ...extras].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
      const key = `${event.at}:${event.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(event);
    }
    return rows;
  }
  // The page the build's crew is on, from the run's own log: every crew event
  // names its page and how many there are. Null before the first, or on a
  // site of one page.
  function crewPage(events) {
    const latest = [...events].reverse().find(event => /^(crew|draft)_/.test(event.phase ?? '') && event.detail?.page && event.detail?.total);
    return latest && latest.detail.total > 1 ? `page ${latest.detail.page} of ${latest.detail.total}` : null;
  }
  // Where the build has got to, as one of the four stages the page drawing
  // shows. Nothing here guesses at a percentage: a stage only moves when the
  // server says the build did.
  function buildStage(draft, events) {
    const phase = belongsToDraft(draft) ? trace?.latest?.status : null;
    if (phase === 'researching') {
      const latestResearch = [...events].reverse().find(event => event.phase?.startsWith('research_'));
      return { step: 1, label: latestResearch?.label || 'Researching design references…' };
    }
    if (draft.status === 'queued' || phase === 'queued') return { step: 1, label: 'Waiting for the build to start…' };
    if (draft.status === 'saving' || phase === 'saving') return { step: 4, label: 'Saving your website…' };
    if (phase === 'images') return { step: 3, label: 'Making the pictures…' };
    const page = crewPage(events);
    if (phase === 'calling') return { step: 2, label: page ? `Writing ${page}…` : 'Writing your website…' };
    const has = label => events.some(event => event.label === label);
    return has('Pictures made for your site') ? { step: 4, label: 'Putting it together…' }
      : has('Page written') ? { step: 3, label: 'Making the pictures…' }
      : has('Agent started building your website') || has('Calling the model') ? { step: 2, label: 'Writing your website…' }
      : { step: 1, label: 'Reading your answers…' };
  }
  // The one progress visual: a page that draws itself in, top to bottom, as
  // the agent works. Each part belongs to a stage — the bar to reading the
  // answers, the words to writing, the picture to making pictures, the button
  // to putting it together — and is inked once its stage is behind it.
  // Each part: its class, the stage that draws it, and where it falls among
  // that stage's parts, which is what staggers the strokes within a stage.
  const PAGE_PARTS = [['name', 1, 0], ['menu', 1, 1], ['head', 2, 0], ['line', 2, 1], ['line build-short', 2, 2], ['picture', 3, 0], ['button', 4, 0]];
  function partState(stage, step) {
    return stage < step ? 'is-drawn' : stage === step ? 'is-drawing' : '';
  }
  function buildPage(step, label, settled = '') {
    const parts = PAGE_PARTS.map(([name, stage, within], order) =>
      `<span class="build-part build-${name} ${partState(stage, step)}" data-stage="${stage}" style="--i:${within};--order:${order}"></span>`);
    return `<div class="build-page${settled ? ` ${settled}` : ''}" role="progressbar" aria-label="Website build progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${Math.min(step - 1, 4)}" aria-valuetext="${escape(label)}"><span class="build-sheet" aria-hidden="true"><span class="build-row">${parts[0]}${parts[1]}</span>${parts.slice(2).join('')}</span></div>`;
  }
  // A new stage repaints the drawing where it stands rather than replacing the
  // screen, so the part being drawn carries on instead of starting over.
  // The log as the member reads it. Once a build has failed, the lines that
  // say why are marked, so the reason stands out rather than being one line
  // among twelve; the ending itself is the screen's title already. While a
  // build runs, a stumble it recovers from is not marked.
  function buildActivity(events, failed = false) {
    const recent = events.filter(event => event.label && event.phase !== 'queued').slice(-12);
    const why = event => failed && event.level === 'error' && event.phase !== 'failed';
    return `<details class="build-activity" open><summary>Build activity</summary><ol>${recent.map(event =>
      `<li${why(event) ? ' data-level="error"' : ''}><time datetime="${new Date(event.at).toISOString()}">${new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><span>${escape(event.label)}</span></li>`
    ).join('')}</ol></details>`;
  }
  function updateBuild(stage, events) {
    const page = screen.querySelector('.build-page');
    const status = screen.querySelector('.build-status');
    if (!page || !status) return false;
    page.querySelectorAll('.build-part').forEach(part => {
      const next = partState(Number(part.dataset.stage), stage.step);
      part.classList.toggle('is-drawn', next === 'is-drawn');
      part.classList.toggle('is-drawing', next === 'is-drawing');
    });
    page.setAttribute('aria-valuenow', String(Math.min(stage.step - 1, 4)));
    page.setAttribute('aria-valuetext', stage.label);
    if (status.textContent !== stage.label) status.textContent = stage.label;
    const activity = screen.querySelector('.build-activity');
    if (activity) {
      const replacement = document.createElement('div');
      replacement.innerHTML = buildActivity(events);
      const next = replacement.firstElementChild;
      const list = activity.querySelector('ol');
      if (next && list) {
        const fresh = next.querySelector('ol');
        const reading = list.scrollTop + list.clientHeight < list.scrollHeight - 8;
        const from = list.scrollTop;
        list.replaceWith(fresh);
        followLog(fresh, reading ? from : null);
      }
    }
    return true;
  }
  // The log keeps its newest line in view -- where the build is now, or the
  // line that stopped it -- unless the member has scrolled up to read.
  function followLog(list, keep = null) {
    if (list) list.scrollTop = keep ?? list.scrollHeight;
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const mark = '<svg class="onboarding-mark" viewBox="0 0 24 30" aria-hidden="true"><path fill="currentColor" stroke="none" d="m12 0 5 5-3 3 10 7-6 15H6L0 15l10-7-3-3Z"/></svg>';
  const shell = content => `<header class="onboarding-header"><span class="onboarding-brand">${mark}Forge Nexxus</span><button type="button" class="onboarding-quiet" data-onboarding-action="signout">Sign out</button></header><div class="onboarding-body">${content}</div>`;
  function error(message) {
    const element = screen.querySelector('.onboarding-error');
    if (element) { element.textContent = message; element.hidden = !message; }
  }
  function setBusy(value) {
    busy = value;
    screen.querySelectorAll('button:not([data-onboarding-action="signout"]):not([data-onboarding-action="cancel"]),input,textarea').forEach(e => { e.disabled = value; });
  }
  function revealDashboard(show) {
    const changed = dashboard.hidden === show;
    dashboard.hidden = !show;
    dashboard.inert = !show;
    if (changed && show) window.dispatchEvent(new Event('resize'));
  }
  function paymentPending() { return awaitingPayment && state?.isFree; }
  function canPreview() {
    if (!ENABLED) return true;
    return Boolean(member && state?.userId === member._id && !state.isFree && !state.required);
  }
  // Only the preview waits for a plan. The globe and the domain settings stay
  // open to everyone: without a plan they are where joining one is offered,
  // and a disabled button cannot sell anything.
  function controls() {
    const allowed = canPreview();
    document.querySelectorAll('.website-preview-button,.site-bar-preview,.message-view').forEach(button => {
      button.disabled = !allowed || (button.matches('.site-bar-preview') && button.dataset.built !== 'true');
      button.setAttribute('aria-disabled', String(button.disabled));
      button.title = state?.isFree ? 'Available with a paid plan' : '';
    });
    document.querySelectorAll('.globe-button,.open-domains').forEach(button => {
      button.disabled = false;
      button.setAttribute('aria-disabled', 'false');
      button.title = '';
    });
  }
  function showWaiting(title, detail, retry = false) {
    const key = `waiting:${title}`;
    if (rendered === key) return;
    rendered = key;
    screen.innerHTML = shell(`<div class="onboarding-content onboarding-loading"><h1 tabindex="-1">${title}</h1><p class="onboarding-hint">${detail}</p>${retry ? '<button class="onboarding-primary" data-onboarding-action="reload">Reload</button>' : ''}<p class="onboarding-error" role="alert" hidden></p></div>`);
  }
  function value() {
    const input = screen.querySelector('[data-answer]');
    const selected = [...screen.querySelectorAll('[data-choice][aria-pressed="true"]')].map(b => b.dataset.choice);
    const extra = input?.value.trim() ?? '';
    return [...selected, ...(extra ? [extra] : [])].join('\n');
  }
  function queueSave(index, answer, advance = false) {
    const id = state?.draft?.id;
    if (!id) return Promise.reject(new Error('Your website setup is still loading.'));
    const task = saveQueue.catch(() => {}).then(() => data.onboarding.save(id, index, answer, advance));
    saveQueue = task;
    return task;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    const index = step;
    const answer = value();
    const saved = screen.querySelector('[data-save-status]');
    if (saved) saved.textContent = 'Saving…';
    saveTimer = setTimeout(() => {
      queueSave(index, answer).then(() => {
        if (saved?.isConnected) saved.textContent = 'Saved';
      }).catch(() => {
        if (saved?.isConnected) saved.textContent = 'Not saved';
        error('Your answer could not be saved. Check your connection and try Continue again.');
      });
    }, 450);
  }
  function renderAssets() {
    const list = screen.querySelector('[data-onboarding-assets]');
    if (!list) return;
    list.innerHTML = (state?.draft?.assets ?? []).map(asset => `<li><span>${escape(asset.name)}</span><button type="button" class="onboarding-quiet" data-remove-asset="${escape(asset.storageId)}" aria-label="Remove ${escape(asset.name)}">Remove</button></li>`).join('');
  }
  function renderQuestion(force = false) {
    const draft = state.draft;
    const q = questions[step];
    if (!q) return;
    const key = `${draft.id}:question:${step}`;
    if (rendered === key && !force) { renderAssets(); return; }
    rendered = key;
    const answer = draft.answers[step] ?? '';
    const selected = answer.split('\n');
    const extra = q.options ? selected.filter(s => !q.options.includes(s)).join('\n') : answer;
    const field = q.id === 'name'
      ? `<input id="onboarding-answer" data-answer type="text" autocomplete="organization" maxlength="${q.limit}" value="${escape(extra)}" aria-labelledby="onboarding-question" ${q.required ? 'required' : ''}>`
      : `<textarea id="onboarding-answer" data-answer rows="${q.options ? 2 : 4}" maxlength="${q.limit}" aria-labelledby="onboarding-question" placeholder="${q.options ? 'Or add your own answer…' : 'Your answer…'}" ${q.required ? 'required' : ''}>${escape(extra)}</textarea>`;
    const choices = q.options ? `<div class="onboarding-choices" role="group" aria-labelledby="onboarding-question">${q.options.map(option => `<button type="button" class="onboarding-choice" data-choice="${escape(option)}" aria-pressed="${selected.includes(option)}">${escape(option)}<span aria-hidden="true"></span></button>`).join('')}</div>` : '';
    screen.innerHTML = shell(`<form class="onboarding-content onboarding-question-form">
      <div class="onboarding-count"><span>Question ${step + 1} of ${questions.length}</span><span data-save-status>Saved</span></div>
      <div class="onboarding-question-progress" role="progressbar" aria-label="Questions completed" aria-valuemin="0" aria-valuemax="${questions.length}" aria-valuenow="${step}"><span style="width:${(step / questions.length) * 100}%"></span></div>
      <h1 id="onboarding-question" tabindex="-1">${escape(q.title)}</h1><p class="onboarding-hint">${escape(q.hint)}</p>
      ${choices}<div class="onboarding-field">${field}</div>
      ${q.id === 'content' ? '<label class="onboarding-upload"><svg aria-hidden="true"><use href="#clip"/></svg><span>Add files</span><input type="file" data-onboarding-files multiple accept="image/png,image/jpeg,image/webp,.txt,.md"></label><p class="onboarding-file-hint">Up to 8 images or text files. Images under 5 MB; text under 100 KB.</p><ul class="onboarding-assets" data-onboarding-assets></ul>' : ''}
      <p class="onboarding-error" role="alert" hidden></p>
      <footer class="onboarding-actions"><button type="button" class="onboarding-quiet" data-onboarding-action="back" ${step === 0 ? 'hidden' : ''}>Back</button><div>${!q.required && step !== lastStep() ? `<button type="button" class="onboarding-quiet" data-onboarding-action="skip">${step === 7 ? 'You decide' : 'Skip'}</button>` : ''}<button type="submit" class="onboarding-primary">${step === lastStep() ? (state.isFree ? 'Choose a plan' : 'Build my website') : 'Continue'}</button></div></footer>
    </form>`) + (state.required ? '' : '<button class="onboarding-exit onboarding-quiet onboarding-dock" type="button" data-onboarding-action="exit">Back to dashboard</button>');
    renderAssets();
  }
  function builtSite() {
    const id = currentDraft()?.siteId;
    return id ? sitesList.find(site => site._id === id) ?? null : null;
  }
  // The finished site is handed over with the address Forge gave it. Nobody is
  // asked to pick one: there is no field here, and nothing waits on a name.
  // The address, with the build that is live on it. The hosting in front of a
  // site caches, and a copy taken before the first publish is the "Nothing
  // here yet" page: stamping the link means a member who has just watched a
  // build finish cannot be handed that. The dashboard's own link does this.
  function liveAddress(site) {
    if (!site?.publishedUrl) return null;
    const stamp = site.publishedVersionId || site.currentVersionId || site.publishedAt;
    if (!stamp) return site.publishedUrl;
    const join = site.publishedUrl.includes('?') ? '&' : '?';
    return `${site.publishedUrl}${join}v=${encodeURIComponent(String(stamp))}`;
  }
  function handoff(site) {
    // A finished build publishes itself, so this is the state a member arrives
    // in. The way on is a real link: it opens the site at its own address in a
    // new tab, and the press that opened it also lands them in the dashboard.
    if (site?.status === 'published' && site.publishedUrl) {
      const address = liveAddress(site);
      return `<a class="onboarding-live-link" href="${escape(address)}" target="_blank" rel="noopener">${escape(site.publishedUrl.replace(/^https?:\/\//, ''))}</a>
        <a class="onboarding-primary" href="${escape(address)}" target="_blank" rel="noopener" data-onboarding-action="finish">View my website</a>
        <div class="onboarding-after"><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="finish">Go to my dashboard</button><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="domain">Change the address or connect a domain</button></div>`;
    }
    if (!site || state.isFree) return '<button type="button" class="onboarding-primary" data-onboarding-action="finish">Open my website</button>';
    // A finished site that is not live -- a claim that failed, or one taken
    // offline. One press publishes it, and the server gives it its address.
    // Publishing is never the only way on: the site is already saved.
    return `<button type="button" class="onboarding-primary" data-onboarding-action="publish" data-publish>Publish my website</button>
      <div class="onboarding-after"><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="finish">Open it as a draft</button></div>`;
  }
  function renderBuild() {
    const draft = currentDraft();
    const done = draft.status === 'complete';
    const failed = draft.status === 'failed';
    const site = done ? builtSite() : null;
    const live = site?.status === 'published' && Boolean(site.publishedUrl);
    const events = progressEvents(draft);
    const key = `${draft.id}:${draft.status}:${events.length}:${trace?.latest?.status ?? ''}:${trace?.latest?.updatedAt ?? ''}:${site?._id ?? ''}:${site?.publishedUrl ?? ''}:${site?.status ?? ''}:${state.isFree}`;
    if (rendered === key) return;
    const building = !done && !failed;
    const stage = buildStage(draft, events);
    // Still building, and this build is already on screen: move the drawing on.
    if (building && screen.querySelector(`.onboarding-loading[data-build-live="${draft.id}"]`) && updateBuild(stage, events)) {
      rendered = key;
      return;
    }
    rendered = key;
    const title = live ? 'Your website is published.' : done ? 'Your website is ready.' : failed ? 'Let’s try that again.' : 'Your idea is taking shape.';
    const detail = live ? 'It is on the web at this address, and every change you make lands there.'
      : done ? (site && !state.isFree ? 'Publish it and Forge gives it an address of its own.' : 'Your first version is saved. Make it yours from your dashboard.')
      : failed ? draft.error : 'Each page is written in turn, so this can take a while. You can close Forge and come back.';
    // Billing is the way on when the build stopped for credits or a plan;
    // otherwise the answers are, so that is what the failed screen offers.
    const aboutBilling = failed && /credit|plan|limit/i.test(draft.error ?? '');
    // A finished build is the whole page inked, and a failed one stops where it
    // got to. The page inks itself in once, when this screen watched the build
    // finish; a later redraw of the finished screen shows it already whole.
    const arriving = done && Boolean(screen.querySelector('.onboarding-loading[data-build-live]'));
    const page = done ? buildPage(5, 'Build finished', `is-done${arriving ? ' is-arriving' : ''}`)
      : failed ? buildPage(stage.step, 'Build stopped', 'is-failed')
      : buildPage(stage.step, stage.label);
    screen.innerHTML = shell(`<div class="onboarding-content onboarding-loading"${building ? ` data-build-live="${escape(draft.id)}"` : ''}>
      ${page}<h1 tabindex="-1">${title}</h1>
      ${building ? `<p class="build-status" role="status">${escape(stage.label)}</p>` : ''}
      <p class="onboarding-hint${building ? ' build-note' : ''}">${escape(detail)}</p>
      ${building || failed ? buildActivity(events, failed) : ''}
      ${building ? '<button type="button" class="onboarding-exit onboarding-quiet onboarding-cancel" data-onboarding-action="cancel">Cancel</button>' : ''}
      <p class="onboarding-connection" role="status" ${offline ? '' : 'hidden'}>Connection lost. Reconnecting to live progress…</p>
      ${done ? handoff(site) : failed ? `<button type="button" class="onboarding-primary" data-onboarding-action="retry">Try building again</button>
        <div class="onboarding-after"><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="${aboutBilling ? 'billing' : 'edit'}">${aboutBilling ? 'Manage billing' : 'Edit my answers'}</button><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="exit">Back to dashboard</button></div>` : ''}
      <p class="onboarding-error" role="alert" hidden></p></div>`);
    followLog(screen.querySelector('.build-activity ol'));
  }
  // The globe owns the address and any domain pointed at it. Open it the way a
  // tap would, once the dashboard is back and the finished site is selected;
  // it opens on the address, with a domain of their own one tab along.
  function openDomains(tries = 0) {
    if (dashboard.hidden && tries < 40) { setTimeout(() => openDomains(tries + 1), 75); return; }
    document.querySelector('.globe-button')?.click();
  }
  // Publishing asks for nothing. A site with no address yet is given one by
  // the server as it goes live, the same way a finished build is.
  async function publishSite() {
    const site = builtSite();
    if (busy || !site) return;
    error(''); setBusy(true);
    const publish = screen.querySelector('[data-publish]');
    if (publish) publish.textContent = 'Publishing…';
    try {
      await data.sites.publish(site._id);
    } catch (caught) {
      error(caught?.data || 'Your website couldn’t be published. Check your connection and try again.');
      if (publish?.isConnected) publish.textContent = 'Publish my website';
    } finally { setBusy(false); render(); }
  }
  function canRebuild() {
    return Boolean(state?.canRebuild || (member && state && !state.isFree && state.hasWebsite));
  }
  function paintRebuild() {
    document.querySelectorAll('.rebuild-site,.site-bar-rebuild').forEach(button => {
      button.hidden = !canRebuild();
    });
  }
  function render() {
    controls();
    paintRebuild();
    if (!ENABLED) {
      screen.hidden = true;
      screen.replaceChildren();
      revealDashboard(Boolean(member));
      return;
    }
    if (!member) { screen.hidden = true; revealDashboard(false); return; }
    if (state?.userId !== member._id || subscriptionError) {
      revealDashboard(false); screen.hidden = false;
      showWaiting(subscriptionError ? 'Your workspace couldn’t load.' : 'Opening your workspace…', subscriptionError ? 'Reload to reconnect. Your saved answers will be here.' : 'Getting your websites and plan.', subscriptionError);
      return;
    }
    if (paymentPending()) {
      revealDashboard(false); screen.hidden = false;
      showWaiting('Confirming your plan…', 'Waiting for payment confirmation. Your website setup will open as soon as your plan is active.', true);
      return;
    }
    if (state && !state.isFree) awaitingPayment = false;
    const row = currentDraft();
    const show = Boolean(state?.required) || Boolean(row);
    revealDashboard(!show); screen.hidden = !show;
    if (!show) { rendered = ''; return; }
    if (!row) {
      showWaiting('Let’s make your first website.', 'Ten simple questions. One at a time.');
      if (!starting && !subscriptionError) {
        starting = true;
        data.onboarding.start().catch(() => {
          subscriptionError = true; render();
        }).finally(() => { starting = false; });
      }
      return;
    }
    if (activeDraft !== row.id) {
      activeDraft = row.id; step = row.step; rendered = '';
    }
    if (busy) return;
    if (row.status === 'questions') renderQuestion();
    else renderBuild();
  }
  async function next(skip = false) {
    if (busy || !state?.draft) return;
    const q = questions[step];
    const answer = skip ? '' : value();
    if (q.required && !answer) { error('Add a short answer to continue.'); screen.querySelector('[data-answer]')?.focus(); return; }
    clearTimeout(saveTimer);
    error(''); setBusy(true);
    try {
      await queueSave(step, answer, true);
      state.draft.answers[step] = answer;
      if (step === lastStep()) {
        if (state.isFree) {
          await data.onboarding.dismiss(state.draft.id);
          document.dispatchEvent(new CustomEvent('forge:choose-plan'));
          return;
        }
        await data.onboarding.submit(state.draft.id);
      } else {
        const content = screen.querySelector('.onboarding-content');
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          await content.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished;
        }
        step += 1;
        renderQuestion(true);
        screen.querySelector('h1')?.focus({ preventScroll: true });
      }
    } catch (caught) { error(caught?.data || 'Your answer could not be saved. Please try again.'); }
    finally { setBusy(false); render(); }
  }
  screen.addEventListener('input', event => {
    if (event.target.matches('[data-answer]')) scheduleSave();
  });
  screen.addEventListener('submit', event => { event.preventDefault(); void next(); });
  screen.addEventListener('click', async event => {
    // A link that carries an action keeps its own job too: the browser opens
    // it in its tab while the action runs here, so nothing is prevented.
    const button = event.target.closest('button,a[data-onboarding-action]');
    if (!button || button.disabled) return;
    if (button.dataset.choice) {
      const selected = button.getAttribute('aria-pressed') === 'true';
      if (!questions[step].multiple) screen.querySelectorAll('[data-choice]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', String(!selected));
      scheduleSave(); return;
    }
    const action = button.dataset.onboardingAction;
    // A submit button belongs to its form; going busy here would disable it
    // before the form ever heard the press.
    if (!action && !button.dataset.removeAsset) return;
    if (action === 'skip') return void next(true);
    if (action === 'publish') return void publishSite();
    if (action === 'reload') return location.reload();
    if (action === 'cancel') {
      error('');
      try { await data.onboarding.cancel(); }
      catch (caught) { error(notDeployed(caught, 'Cancel') || caught?.data || caught?.message || 'The build couldn’t be cancelled. Try again.'); }
      return;
    }
    if (busy && action !== 'signout') return;
    setBusy(true); error('');
    try {
      if (action === 'signout') { clearTimeout(saveTimer); await saveQueue.catch(() => {}); await data.auth.signOut(); }
      if (action === 'back' && step > 0) {
        clearTimeout(saveTimer);
        const answer = value();
        await queueSave(step, answer);
        state.draft.answers[step] = answer;
        const previous = step - 1;
        await queueSave(previous, state.draft.answers[previous] ?? '');
        const content = screen.querySelector('.onboarding-content');
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await content.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished;
        step = previous; renderQuestion(true); screen.querySelector('h1')?.focus({preventScroll:true});
      }
      if (button.dataset.removeAsset) await data.onboarding.detach(state.draft.id, button.dataset.removeAsset);
      if (action === 'retry') await data.onboarding.submit(state.draft.id);
      if (action === 'billing') { const {url} = await data.billing.portal(); location.assign(url); }
      // Saving an answer is what reopens a brief whose build failed; the last
      // question comes back with Back leading through the rest.
      if (action === 'edit') {
        step = questions.length - 1;
        await queueSave(step, state.draft.answers[step] ?? '');
        rendered = '';
      }
      if (action === 'finish' || action === 'exit' || action === 'domain') {
        clearTimeout(saveTimer);
        if (state.draft.status === 'questions') await queueSave(step, value());
        const siteId = state.draft.siteId;
        await data.onboarding.dismiss(state.draft.id);
        if (siteId) document.dispatchEvent(new CustomEvent('forge:onboarding-complete', {detail: {siteId}}));
        if (action === 'domain') openDomains();
      }
    } catch (caught) { error(caught?.data || 'That change couldn’t be saved. Please try again.'); }
    finally { setBusy(false); render(); }
  });
  screen.addEventListener('change', async event => {
    if (!event.target.matches('[data-onboarding-files]')) return;
    const files = [...event.target.files];
    const id = state.draft.id;
    setBusy(true); error('');
    try {
      if (files.length + state.draft.assets.length > 8) throw new Error('Choose up to eight files in total.');
      for (const file of files) {
        const type = /\.md$/i.test(file.name) ? 'text/markdown' : /\.txt$/i.test(file.name) ? 'text/plain' : file.type;
        if (!['image/png','image/jpeg','image/webp','text/plain','text/markdown'].includes(type) || file.size > (type.startsWith('text/') ? 100000 : 5000000)) throw new Error('Use PNG, JPG or WebP under 5 MB, or text files under 100 KB.');
        const url = await data.onboarding.uploadUrl(id);
        const response = await fetch(url, {method:'POST', headers:{'Content-Type':type}, body:file});
        if (!response.ok) throw new Error('The file couldn’t be uploaded. Please try again.');
        const {storageId} = await response.json();
        await data.onboarding.attach(id, storageId, file.name);
      }
    } catch (caught) { error(caught.message || 'The upload couldn’t be completed.'); }
    finally { setBusy(false); renderAssets(); event.target.value = ''; }
  });
  function connection() {
    offline = !navigator.onLine;
    const note = screen.querySelector('.onboarding-connection');
    if (note) note.hidden = !offline;
  }
  window.addEventListener('online', connection);
  window.addEventListener('offline', connection);
  document.addEventListener('forge:active-site', controls);
  document.addEventListener('forge:billing', controls);
  // Flush a last edit while a backgrounded tab still has a live connection.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && saveTimer && state?.draft?.status === 'questions') {
      clearTimeout(saveTimer); saveTimer = null;
      void queueSave(step, value()).catch(() => {});
    }
  });
  window.ForgeOnboarding = {
    enabled: ENABLED,
    canPreview,
    canRebuild,
    setMember(user) {
      if (member?._id !== user?._id) { activeDraft = null; rendered = ''; }
      member = user && !user.isAnonymous ? user : null;
      render();
    },
    async start() {
      if (!ENABLED || !member) return;
      await data.onboarding.start();
    },
    // Whether this account is testing rebuilds: no questions, and every
    // rebuild is a new invented business.
    testing: () => Boolean(state?.testing),
    async rebuild(siteId, options) {
      if (!ENABLED || !member) return;
      try {
        await data.onboarding.rebuild(siteId, options);
      } catch (caught) {
        const missing = notDeployed(caught, 'Rebuild');
        throw missing ? new Error(missing) : caught;
      }
    },
  };
  data?.onboarding.subscribe(nextState => {
    if (nextState) { state = nextState; subscriptionError = false; }
    render();
  }, () => { subscriptionError = true; render(); });
  data?.diagnostics?.subscribe?.(next => {
    trace = next;
    render();
  });
  // The hand-off redraws when the finished site's address or status changes.
  data?.sites?.subscribe?.(list => {
    sitesList = Array.isArray(list) ? list : [];
    if (currentDraft()?.status === 'complete') render();
  });
})();
