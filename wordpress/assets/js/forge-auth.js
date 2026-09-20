// The front door. Building needs an account so credits belong to someone, so
// guests never reach the app; every method here creates or opens an account.
(() => {
  const gate = document.querySelector('#auth-gate');
  const dashboard = document.querySelector('main.app');
  const data = window.ForgeData;
  const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
  const google = `<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59A5.99 5.99 0 0 1 12 5.96Z"/></svg>`;
  const provider = name => `<button class="auth-button auth-provider ${name}" type="button" data-auth-provider="${name}">${name === 'google' ? google : icon('apple')}<span>Continue with ${name === 'google' ? 'Google' : 'Apple'}</span></button>`;
  const back = target => `<button class="auth-back" type="button" data-auth-screen="${target}" aria-label="Back">${icon('arrow-left')}</button>`;
  const mark = `<svg class="auth-mark" viewBox="0 0 24 30" aria-hidden="true"><path fill="currentColor" d="m12 0 5 5-3 3 10 7-6 15H6L0 15l10-7-3-3Z"/></svg>`;
  const field = (name, label, placeholder, type = 'text', autocomplete = name) => `<label class="auth-field">${label}<input name="${name}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" required ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}></label>`;
  function status(message, error = false) {
    const element = gate.querySelector('.auth-message');
    element.textContent = message;
    element.hidden = false;
    element.classList.toggle('error', error);
  }
  function render(next) {
    // The handoff wears the welcome layout: it is the same front door, mid-step.
    gate.className = next === 'handoff' ? 'auth-gate auth-welcome auth-handoff' : `auth-gate auth-${next}`;
    const message = '<p class="auth-message" role="status" aria-live="polite" hidden></p>';
    if (next === 'handoff') gate.innerHTML = `<div class="auth-hero">${mark}<h1>Forge Nexxus</h1><p>Signing you in…</p></div><div class="auth-welcome-sheet"><p class="auth-signing" role="status" aria-live="polite"><span class="auth-spinner" aria-hidden="true"></span>Finishing sign-in…</p><p class="auth-fineprint">Keep this page open — this only takes a moment.</p>${message}</div>`;
    if (next === 'welcome') gate.innerHTML = `<div class="auth-hero">${mark}<h1>Forge Nexxus</h1><p>Describe the website you want. Forge designs it, builds it and publishes it.</p></div><div class="auth-welcome-sheet">${provider('apple')}${provider('google')}<button class="auth-button" type="button" data-auth-screen="email">Continue with email</button><p class="auth-fineprint">Every plan comes with monthly credits.</p>${message}</div>`;
    if (next === 'email') gate.innerHTML = `<div class="auth-login-content">${back('welcome')}<h1>Sign in to build</h1><p class="auth-intro">Enter your email and we'll send you a sign-in link. New here? The link creates your account — there's no password to remember.</p><form class="auth-email-form">${field('email', 'Email address', 'you@example.com', 'email')}<button class="auth-button auth-primary">Send sign-in link</button></form><div class="auth-or">OR</div><div class="auth-social">${provider('google')}${provider('apple')}</div>${message}<p class="auth-switch">Your sites, credits and settings follow your account on every device.</p></div>`;
    gate.scrollTop = 0;
    // Bind navigation to the button itself: SVG <use> targets on iOS can
    // originate in the referenced symbol instead of the button's DOM tree.
    gate.querySelectorAll('[data-auth-screen]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        render(event.currentTarget.dataset.authScreen);
      });
    });
  }
  // Landing back from a provider is not a fresh visit: the exchange is already
  // running, so show that rather than the buttons that started it. A provider
  // that sent us home with nothing has already been worked out by then, and
  // says so here -- no listener is subscribed yet when that is decided.
  const arrival = data?.auth.handoff() ?? { pending: null, error: null };
  render(arrival.pending ? 'handoff' : 'welcome');
  if (arrival.error) status(arrival.error, true);
  gate.addEventListener('click', async event => {
    const target = event.composedPath().find(node => node instanceof HTMLButtonElement);
    if (!target) return;
    if (target.dataset.authScreen) return render(target.dataset.authScreen);
    if (target.dataset.authProvider) {
      target.disabled = true;
      try {
        if (!data?.auth) throw new Error('Sign-in is unavailable. Please reload and try again.');
        await data.ready;
        await data.auth.signInWith(target.dataset.authProvider);
      } catch (error) { status(error.message || 'Unable to start sign-in. Please try again.', true); target.disabled = false; }
    }
  });
  gate.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"], .auth-primary');
    button.disabled = true;
    try {
      if (!data?.auth) throw new Error('Sign-in is unavailable. Please reload and try again.');
      await data.ready;
      const sent = await data.auth.signInWithEmail(event.target.elements.email.value.trim());
      if (!sent) throw new Error('The sign-in email could not be sent. Please try again.');
      status('Check your inbox for a sign-in link. Open it on this device to continue.');
    } catch (error) { status(error.message || 'Unable to send your sign-in link.', true); }
    finally { button.disabled = false; }
  });
  // Never trust a cached token/kind or a URL parameter to reveal the app. Only
  // the server's answer about this session can unlock it for a real member --
  // the live subscription, or the confirmation the client asks for directly
  // with a freshly minted token when a sign-in lands.
  let confirmed = false;
  function lock() {
    confirmed = false;
    window.ForgeOnboarding?.setMember(null);
    dashboard.hidden = true;
    dashboard.inert = true;
    gate.hidden = false;
  }
  data?.account.subscribe(user => {
    // `null` is not the server saying "guest": the live query re-runs
    // unauthenticated while its socket re-authenticates, and treating that as
    // an answer shut a member who had just signed in back out. An anonymous
    // row is a real answer, and still locks.
    if (user === null && confirmed && data.auth.state().kind === 'member') return;
    const member = Boolean(user && !user.isAnonymous);
    confirmed = member;
    // A confirmed account still waits for the authoritative website/plan
    // gate. Do not briefly flash the dashboard during sign-in or a reload.
    window.ForgeOnboarding?.setMember(member ? user : null);
    if (!window.ForgeOnboarding) { dashboard.hidden = true; dashboard.inert = true; }
    gate.hidden = member;
    if (member) window.dispatchEvent(new Event('resize'));
  });
  data?.auth.onChange(state => { if (!state.signedIn || state.kind !== 'member') lock(); });
  // A handoff that fails says so here. It used to fail into the welcome screen
  // with nothing written on it, which reads as "nothing happened".
  data?.auth.onHandoff(({ pending, error }) => {
    if (pending) { if (!gate.classList.contains('auth-handoff')) render('handoff'); return; }
    if (error) { render('welcome'); status(error, true); }
  });
})();
