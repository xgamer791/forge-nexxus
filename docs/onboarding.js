// One full-screen route owns access to the app. The server decides whether a
// paid member has a built website; local flags and URL parameters never do.
// ENABLED is the one switch for the website-setup route. The server never
// traps anyone in it: a failed build can always be left for the dashboard.
const ENABLED = true;
(() => {
  const data = window.ForgeData;
  const questions = data?.onboardingQuestions ?? [];
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
  let localBuild = null;
  const REBUILD_PROMPT = 'Rebuild this website from scratch. Discard the current design. Use only real business facts already known. Return one complete new HTML document, not an edit of the old page.';
  function missingRebuild(error) {
    return /Could not find public function|onboarding:rebuild/i.test(String(error?.data || error?.message || ''));
  }
  function currentDraft() {
    return localBuild || state?.draft || null;
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
    screen.querySelectorAll('button:not([data-onboarding-action="signout"]),input,textarea').forEach(e => { e.disabled = value; });
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
    screen.innerHTML = shell(`<div class="onboarding-content onboarding-loading"><div class="build-emblem" aria-hidden="true">${mark}</div><h1 tabindex="-1">${title}</h1><p class="onboarding-hint">${detail}</p>${retry ? '<button class="onboarding-primary" data-onboarding-action="reload">Reload</button>' : ''}<p class="onboarding-error" role="alert" hidden></p></div>`);
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
      <div class="onboarding-question-progress" role="progressbar" aria-label="Questions completed" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${step}"><span style="width:${step * 10}%"></span></div>
      <h1 id="onboarding-question" tabindex="-1">${escape(q.title)}</h1><p class="onboarding-hint">${escape(q.hint)}</p>
      ${choices}<div class="onboarding-field">${field}</div>
      ${step === 9 ? '<label class="onboarding-upload"><svg aria-hidden="true"><use href="#clip"/></svg><span>Add files</span><input type="file" data-onboarding-files multiple accept="image/png,image/jpeg,image/webp,.txt,.md"></label><p class="onboarding-file-hint">Up to 8 images or text files. Images under 5 MB; text under 100 KB.</p><ul class="onboarding-assets" data-onboarding-assets></ul>' : ''}
      <p class="onboarding-error" role="alert" hidden></p>
      <footer class="onboarding-actions"><button type="button" class="onboarding-quiet" data-onboarding-action="back" ${step === 0 ? 'hidden' : ''}>Back</button><div>${!q.required && step !== 9 ? `<button type="button" class="onboarding-quiet" data-onboarding-action="skip">${step === 7 ? 'You decide' : 'Skip'}</button>` : ''}<button type="submit" class="onboarding-primary">${step === 9 ? (state.isFree ? 'Choose a plan' : 'Build my website') : 'Continue'}</button></div></footer>
      ${!state.required ? '<button class="onboarding-exit onboarding-quiet" type="button" data-onboarding-action="exit">Back to dashboard</button>' : ''}
    </form>`);
    renderAssets();
  }
  function builtSite() {
    const id = currentDraft()?.siteId;
    return id ? sitesList.find(site => site._id === id) ?? null : null;
  }
  // The finished site is handed over with the address Forge gave it. Nobody is
  // asked to pick one: there is no field here, and nothing waits on a name.
  function handoff(site) {
    // A finished build publishes itself, so this is the state a member arrives
    // in. The way on is a real link: it opens the site at its own address in a
    // new tab, and the press that opened it also lands them in the dashboard.
    if (site?.status === 'published' && site.publishedUrl) {
      return `<a class="onboarding-live-link" href="${escape(site.publishedUrl)}" target="_blank" rel="noopener">${escape(site.publishedUrl.replace(/^https?:\/\//, ''))}</a>
        <a class="onboarding-primary" href="${escape(site.publishedUrl)}" target="_blank" rel="noopener" data-onboarding-action="finish">View my website</a>
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
    const key = `${draft.id}:${draft.status}:${draft.events.length}:${site?._id ?? ''}:${site?.publishedUrl ?? ''}:${site?.status ?? ''}:${state.isFree}`;
    if (rendered === key) return;
    rendered = key;
    const has = label => draft.events.some(event => event.label === label);
    const title = live ? 'Your website is published.' : done ? 'Your website is ready.' : failed ? 'Let’s try that again.' : 'Your idea is taking shape.';
    const detail = live ? 'It is on the web at this address, and every change you make lands there.'
      : done ? (site && !state.isFree ? 'Publish it and Forge gives it an address of its own.' : 'Your first version is saved. Make it yours from your dashboard.')
      : failed ? draft.error : 'Forge is creating your website from your answers. You can return to this screen at any time.';
    const progress = draft.status === 'queued' ? 'Waiting for the build to start…'
      : draft.status === 'saving' ? 'Saving your website…'
      : has('Pictures made for your site') ? 'Putting the page together…'
      : has('Page written') ? 'Making pictures for your site…'
      : has('Agent started building your website') ? 'Agent is building…' : 'Preparing the agent…';
    // Billing is the way on when the build stopped for credits or a plan;
    // otherwise the answers are, so that is what the failed screen offers.
    const aboutBilling = failed && /credit|plan|limit/i.test(draft.error ?? '');
    screen.innerHTML = shell(`<div class="onboarding-content onboarding-loading ${done || failed ? 'is-settled' : ''}">
      <div class="build-emblem" aria-hidden="true">${mark}</div><h1 tabindex="-1">${title}</h1><p class="onboarding-hint">${escape(detail)}</p>
      ${done ? '' : `<div class="onboarding-build-log" role="log" aria-live="polite" aria-label="Website build progress">${draft.events.map(event => `<div class="onboarding-milestone"><svg aria-hidden="true"><use href="#check"/></svg><span>${escape(event.label)}</span></div>`).join('')}</div>`}
      ${!done && !failed ? `<p class="onboarding-live" role="status"><span class="onboarding-spinner" aria-hidden="true"></span>${progress}</p>` : ''}
      <p class="onboarding-connection" role="status" ${offline ? '' : 'hidden'}>Connection lost. Reconnecting to live progress…</p>
      ${done ? handoff(site) : failed ? `<button type="button" class="onboarding-primary" data-onboarding-action="retry">Try building again</button>
        <div class="onboarding-after"><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="${aboutBilling ? 'billing' : 'edit'}">${aboutBilling ? 'Manage billing' : 'Edit my answers'}</button><button type="button" class="onboarding-exit onboarding-quiet" data-onboarding-action="exit">Back to dashboard</button></div>` : ''}
      <p class="onboarding-error" role="alert" hidden></p></div>`);
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
    if (localBuild) return false;
    return Boolean(state?.canRebuild || (member && state && !state.isFree && state.hasWebsite));
  }
  function markLocal(status, label) {
    if (!localBuild) return;
    localBuild = {
      ...localBuild,
      status,
      events: label ? [...localBuild.events, { label, at: Date.now() }] : localBuild.events,
      error: status === 'failed' ? label : undefined,
    };
    rendered = '';
    render();
  }
  async function rebuildWithoutServer() {
    const site = sitesList.find(row => row.currentVersionId) || sitesList[0];
    if (!site?.conversationId) throw new Error('Open a site to rebuild it.');
    localBuild = {
      id: site._id,
      siteId: site._id,
      answers: [],
      step: 9,
      status: 'queued',
      events: [{ label: 'Rebuilding from your answers', at: Date.now() }],
      assets: [],
      local: true,
    };
    rendered = '';
    render();
    if (site.status === 'published') {
      try { await data.sites.unpublish(site._id); } catch { /* The rebuild still runs. */ }
    }
    markLocal('building', 'Agent started building your website');
    await data.generate(site.conversationId, REBUILD_PROMPT);
    markLocal('complete', 'Website saved and ready');
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
    if (!localBuild && (state?.userId !== member._id || subscriptionError)) {
      revealDashboard(false); screen.hidden = false;
      showWaiting(subscriptionError ? 'Your workspace couldn’t load.' : 'Opening your workspace…', subscriptionError ? 'Reload to reconnect. Your saved answers will be here.' : 'Getting your websites and plan.', subscriptionError);
      return;
    }
    if (!localBuild && paymentPending()) {
      revealDashboard(false); screen.hidden = false;
      showWaiting('Confirming your plan…', 'Waiting for payment confirmation. Your website setup will open as soon as your plan is active.', true);
      return;
    }
    if (state && !state.isFree) awaitingPayment = false;
    const row = currentDraft();
    const show = Boolean(localBuild) || Boolean(state?.required) || Boolean(row);
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
      if (step === 9) {
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
      if (action === 'retry') {
        if (localBuild) await rebuildWithoutServer();
        else await data.onboarding.submit(state.draft.id);
      }
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
        if (localBuild) {
          const siteId = localBuild.siteId;
          localBuild = null;
          rendered = '';
          if (siteId) document.dispatchEvent(new CustomEvent('forge:onboarding-complete', {detail: {siteId}}));
          if (action === 'domain') openDomains();
          return;
        }
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
    async rebuild() {
      if (!ENABLED || !member) return;
      try {
        await data.onboarding.rebuild();
      } catch (caught) {
        if (!missingRebuild(caught)) throw caught;
        try {
          await rebuildWithoutServer();
        } catch (failed) {
          markLocal('failed', failed?.data || failed?.message || 'Your website couldn’t be completed. Try building again.');
          throw failed;
        }
      }
    },
  };
  data?.onboarding.subscribe(nextState => {
    if (nextState) { state = nextState; subscriptionError = false; }
    render();
  }, () => { subscriptionError = true; render(); });
  // The hand-off redraws when the finished site's address or status changes.
  data?.sites?.subscribe?.(list => {
    sitesList = Array.isArray(list) ? list : [];
    if (currentDraft()?.status === 'complete') render();
  });
})();
