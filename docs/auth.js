// UI-only signup fields; existing Convex providers own authentication.
(() => {
  const gate = document.querySelector('#auth-gate');
  const dashboard = document.querySelector('main.app');
  const data = window.ForgeData;
  const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
  const google = `<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59A5.99 5.99 0 0 1 12 5.96Z"/></svg>`;
  const provider = (name, label = 'Continue with') => `<button class="auth-button auth-provider ${name}" type="button" data-auth-provider="${name}">${name === 'google' ? google : icon('apple')}<span>${label} ${name === 'google' ? 'Google' : 'Apple'}</span></button>`;
  const back = target => `<button class="auth-back" type="button" data-auth-screen="${target}" aria-label="Back">${icon('chevron-left')}</button>`;
  const footer = `<p class="auth-switch">Already have an account? <button type="button" data-auth-screen="email">Sign in</button></p>`;
  const field = (name, label, placeholder, type = 'text', autocomplete = name) => `<label class="auth-field">${label}<input name="${name}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" required ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}></label>`;
  const logo = `<svg class="auth-logo" viewBox="0 0 40 50" aria-hidden="true"><g stroke="#849096" stroke-width="1.2"><path d="M4 30V9l8-5h5l2-2h6l2 2h5l4 5v21M8 28V7m24 21V7M4 12l10 8-10 8m32-16-10 8 10 8M12 9v22l8 8 8-8V9M2 31l18 10 18-10M5 34v5l8 6h5m17-11v5l-8 6h-5M13 48h4l3-2 3 2h4M7 32h26M14 16l-4 10m16-10 4 10"/><path stroke="#c58031" d="M20 10v24m-5-24v7l3 4v8l-3 3 5 5 5-5-3-3v-8l3-4v-7"/><circle cx="20" cy="8" r="2" stroke="#c58031"/><circle cx="15" cy="8" r="1.5" stroke="#c58031"/><circle cx="25" cy="8" r="1.5" stroke="#c58031"/></g></svg>`;
  let screen = 'welcome';
  function status(message, error = false) {
    const element = gate.querySelector('.auth-message');
    element.textContent = message;
    element.hidden = false;
    element.classList.toggle('error', error);
  }
  function render(next) {
    screen = next;
    gate.className = `auth-gate auth-${next}`;
    const message = '<p class="auth-message" role="status" aria-live="polite" hidden></p>';
    if (next === 'welcome') gate.innerHTML = `<div class="auth-welcome-sheet">${provider('apple')}${provider('google')}<button class="auth-button" type="button" data-auth-screen="email">Log in or sign up</button>${message}</div>`;
    if (next === 'email') gate.innerHTML = `<div class="auth-login-content">${back('welcome')}<h1>Welcome to Forge Nexus</h1><p class="auth-intro">Your secure multi-model AI workspace.<br>Choose Forge Managed Access or bring your own API keys — your data stays local and encrypted.</p><form class="auth-email-form">${field('email', 'Email address', 'you@example.com', 'email')}<button class="auth-button auth-primary">Continue</button></form><div class="auth-or">OR</div><div class="auth-social">${provider('google')}${provider('apple')}</div>${message}<p class="auth-recovery"><button type="button" data-recovery="password">Forgot password?</button><span>·</span><button type="button" data-recovery="username">Forgot username?</button></p><p class="auth-switch">Don't have an account? <button type="button" data-auth-screen="signup">Sign up</button></p></div>`;
    if (next === 'signup' || next === 'register') {
      gate.innerHTML = `<header class="auth-header">${back(next === 'register' ? 'signup' : 'email')}<h1>Create account</h1></header><div class="auth-signup-content">${logo}<h2>Create your Forge Nexus account</h2>${next === 'signup' ? `<div class="auth-signup-options">${provider('apple', 'Create account with')}${provider('google', 'Create account with')}<div class="auth-or">OR</div><button class="auth-button auth-primary" type="button" data-auth-screen="register">Create account with email</button></div>${message}${footer}` : `<form class="auth-register-form">${field('given-name', 'First name', 'Alex')}${field('family-name', 'Last name', 'Smith')}${field('email', 'Email address', 'you@example.com', 'email')}<label class="auth-field">Create a password<div class="auth-password"><input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required aria-describedby="password-rules"><button type="button" class="auth-show" aria-pressed="false">Show</button></div></label><div class="auth-rules" id="password-rules"><p>Your password must include the following:</p><ul><li data-rule="length">10–256 characters</li><li data-rule="case">Upper &amp; lowercase letters</li><li data-rule="number">At least one number</li></ul></div><label class="auth-marketing"><input type="checkbox" name="updates" checked><span>Send me emails about Forge updates, new features, and tips.</span></label><p class="auth-terms">By clicking Continue, you acknowledge you have read and agreed to our <button type="button" data-legal="Terms of Use">Terms of Use</button> and <button type="button" data-legal="Privacy Policy">Privacy Policy</button>.</p><button class="auth-button auth-primary auth-register-submit" disabled>Continue</button>${message}</form>${footer}`}</div>`;
    }
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
  render('welcome');
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
    if (target.classList.contains('auth-show')) {
      const password = gate.querySelector('[name="password"]');
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      target.textContent = show ? 'Hide' : 'Show';
      target.setAttribute('aria-pressed', String(show));
    }
    if (target.dataset.recovery) status('Enter your account email above and select Continue. We’ll send you a sign-in link; no password or username is needed.');
    if (target.dataset.legal) status(`${target.dataset.legal} will be available before email account creation launches.`);
  });
  gate.addEventListener('input', () => {
    const form = gate.querySelector('.auth-register-form');
    if (!form) return;
    const password = form.elements.password.value;
    const rules = { length: password.length >= 10 && password.length <= 256, case: /[a-z]/.test(password) && /[A-Z]/.test(password), number: /[0-9]/.test(password) };
    Object.entries(rules).forEach(([name, passed]) => gate.querySelector(`[data-rule="${name}"]`).classList.toggle('passed', passed));
    form.querySelector('.auth-register-submit').disabled = !Object.values(rules).every(Boolean) || !form.checkValidity();
  });
  gate.addEventListener('submit', async event => {
    event.preventDefault();
    if (event.target.matches('.auth-register-form')) {
      status('Email/password account creation is not available yet. Go back to create your account with Apple or Google.');
      return;
    }
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
  // Never trust a cached token/kind or a URL parameter to reveal the dashboard.
  // Only the server's account subscription can unlock it for a real member.
  function lock() {
    dashboard.hidden = true;
    dashboard.inert = true;
    gate.hidden = false;
  }
  data?.account.subscribe(user => {
    const member = Boolean(user && !user.isAnonymous);
    dashboard.hidden = !member;
    dashboard.inert = !member;
    gate.hidden = member;
    if (member) window.dispatchEvent(new Event('resize'));
  });
  data?.auth.onChange(state => { if (!state.signedIn || state.kind !== 'member') lock(); });
})();
