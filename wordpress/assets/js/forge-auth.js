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
  const field = (name, label, placeholder, type = 'text', autocomplete = name) => `<label class="auth-field">${label}<input name="${name}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" required ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}></label>`;
  const heroMessages = [
    'World class website designs in minutes',
    'Not just a beautiful design, we aim to scale your business',
    'Fully customized tools with your needs in mind',
    'Legendary customer support that exceeds expectations',
    'Don’t fall behind ai, let it work for you with Forge Nexxus',
  ];
  const escapeHtml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const heroFilm = () => {
    const video = gate.dataset.heroVideo || '';
    const poster = gate.dataset.heroPoster || '';
    if (!video) return '';
    const source = `<source src="${escapeHtml(video)}" type="video/mp4">`;
    return `<div class="auth-hero-film" aria-hidden="true">
      <video class="auth-hero-video is-active" autoplay muted playsinline preload="auto" poster="${escapeHtml(poster)}" tabindex="-1" disablepictureinpicture data-hero-loop>${source}</video>
      <video class="auth-hero-video" muted playsinline preload="auto" tabindex="-1" disablepictureinpicture data-hero-loop>${source}</video>
    </div>`;
  };
  // The film held on its poster, for a state that lasts a moment: no video to
  // fetch or play for a member who is only being let back in.
  const heroStill = () => '<div class="auth-hero-film" aria-hidden="true"></div>';
  const heroRotator = () => `<div class="auth-message-rotator" data-hero-messages aria-hidden="true">${
    heroMessages.map((line, index) => `<p class="hero-message${index === 0 ? ' is-active' : ''}">${escapeHtml(line)}</p>`).join('')
  }</div><ul class="visually-hidden">${
    heroMessages.map(line => `<li>${escapeHtml(line)}</li>`).join('')
  }</ul>`;

  let stopHero = () => {};

  function startHeroFilm() {
    const heroLoops = [...gate.querySelectorAll('[data-hero-loop]')];
    if (!heroLoops.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    heroLoops.forEach(video => {
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
    });
    if (heroLoops.length === 2) {
      // The file is one forward stroke that crossfades back to the first
      // frame — no reversed frames. Two layers cut on the matching ends
      // so iOS never seeks on screen.
      const lead = 2 / 24;
      let active = heroLoops[0];
      let standby = heroLoops[1];
      let switching = false;
      const rewind = video => {
        try { video.currentTime = 0; } catch { /* seek before metadata */ }
      };
      const nativeLoop = video => {
        video.loop = true;
        void video.play().catch(() => {});
      };
      heroLoops.forEach(video => {
        video.loop = false;
        if (video.readyState >= 1) rewind(video);
        else video.addEventListener('loadedmetadata', () => rewind(video), { once: true });
      });
      const swap = async () => {
        if (switching) return;
        switching = true;
        rewind(standby);
        try {
          await standby.play();
          standby.classList.add('is-active');
          active.classList.remove('is-active');
          const previous = active;
          active = standby;
          standby = previous;
          previous.pause();
          rewind(previous);
          switching = false;
        } catch {
          switching = false;
          nativeLoop(active);
        }
      };
      let following = true;
      const follow = () => {
        if (!following) return;
        if (
          !switching &&
          Number.isFinite(active.duration) &&
          active.duration > lead &&
          active.currentTime >= active.duration - lead
        ) swap();
        requestAnimationFrame(follow);
      };
      requestAnimationFrame(follow);
      active.addEventListener('ended', () => { if (!switching) swap(); });
      void active.play().catch(() => nativeLoop(active));
      const previousStop = stopHero;
      stopHero = () => { following = false; previousStop(); };
      return;
    }
    heroLoops[0].loop = true;
    void heroLoops[0].play().catch(() => {});
  }

  function startHeroCascade() {
    const messageStage = gate.querySelector('[data-hero-messages]');
    const messages = [...(messageStage?.querySelectorAll('.hero-message') || [])];
    if (!messages.length) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wordDelayMs = 95;
    const wordEnterMs = 766;
    const exitMs = 422;
    const holdMs = 4000;
    let stopped = false;
    const previousStop = stopHero;
    stopHero = () => { stopped = true; previousStop(); };

    messages.forEach(message => {
      const words = message.textContent.trim().split(/\s+/);
      const fragment = document.createDocumentFragment();
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.className = 'hero-message-word';
        span.style.setProperty('--word-index', String(index));
        span.textContent = index < words.length - 1 ? `${word} ` : word;
        fragment.append(span);
      });
      message.replaceChildren(fragment);
      message.classList.remove('is-active', 'is-leaving');
      message.dataset.wordCount = String(words.length);
    });

    if (reducedMotion) {
      messages[0].classList.add('is-active');
      return;
    }

    const wait = duration => new Promise(resolve => setTimeout(resolve, duration));
    const playMessages = async () => {
      let index = 0;
      while (!stopped) {
        const message = messages[index];
        message.classList.remove('is-leaving');
        await wait(53);
        if (stopped) break;
        message.classList.add('is-active');
        const wordCount = Number(message.dataset.wordCount) || 1;
        await wait(wordEnterMs + ((wordCount - 1) * wordDelayMs));
        await wait(holdMs);
        if (stopped) break;
        message.classList.remove('is-active');
        message.classList.add('is-leaving');
        await wait(exitMs);
        message.classList.remove('is-leaving');
        index += 1;
        if (index === messages.length) index = 0;
      }
    };
    void playMessages();
  }

  // A saved session is confirmed in a moment on a live connection. Without
  // one it waits, and says what it is waiting for.
  function restoringLine() {
    return navigator.onLine ? 'Signing you back in…' : 'You\u2019re offline. Forge will sign you back in when you reconnect.';
  }
  function repaintRestoring() {
    const line = gate.querySelector('[data-restoring-line]');
    if (line) line.textContent = restoringLine();
  }
  window.addEventListener('online', repaintRestoring);
  window.addEventListener('offline', repaintRestoring);
  function status(message, error = false) {
    const element = gate.querySelector('.auth-message');
    element.textContent = message;
    element.hidden = false;
    element.classList.toggle('error', error);
  }
  function render(next) {
    stopHero();
    stopHero = () => {};
    // The handoff wears the welcome layout: it is the same front door, mid-step.
    // So does restoring, which is a member who is already signed in being let
    // back in after a reload -- not the front door at all, so no buttons.
    gate.className = next === 'handoff' ? 'auth-gate auth-welcome auth-handoff'
      : next === 'restoring' ? 'auth-gate auth-welcome auth-handoff auth-restoring'
      : `auth-gate auth-${next}`;
    const message = '<p class="auth-message" role="status" aria-live="polite" hidden></p>';
    if (next === 'restoring') gate.innerHTML = `${heroStill()}<div class="auth-hero"><h1 class="visually-hidden">Forge Nexxus</h1></div><div class="auth-welcome-sheet"><p class="auth-signing" role="status" aria-live="polite"><span class="auth-spinner" aria-hidden="true"></span><span data-restoring-line>${restoringLine()}</span></p>${message}</div>`;
    if (next === 'handoff') gate.innerHTML = `${heroFilm()}<div class="auth-hero"><h1 class="visually-hidden">Forge Nexxus</h1></div><div class="auth-welcome-sheet"><p class="auth-signing" role="status" aria-live="polite"><span class="auth-spinner" aria-hidden="true"></span>Finishing sign-in…</p><p class="auth-fineprint">Keep this page open — this only takes a moment.</p>${message}</div>`;
    if (next === 'welcome') gate.innerHTML = `${heroFilm()}<div class="auth-hero"><h1 class="visually-hidden">Forge Nexxus</h1>${heroRotator()}</div><div class="auth-welcome-sheet">${provider('apple')}${provider('google')}<button class="auth-button" type="button" data-auth-screen="email">Continue with email</button><p class="auth-switch">Already have an account? <button type="button" data-auth-screen="email">Sign in</button></p><p class="auth-fineprint">Every plan comes with monthly credits.</p>${message}</div>`;
    if (next === 'email') gate.innerHTML = `<div class="auth-login-content">${back('welcome')}<h1>Sign in to build</h1><p class="auth-intro">Enter your email and we'll send you a sign-in link. New here? The link creates your account — there's no password to remember.</p><form class="auth-email-form">${field('email', 'Email address', 'you@example.com', 'email')}<button class="auth-button auth-primary">Send sign-in link</button></form><div class="auth-or">OR</div><div class="auth-social">${provider('google')}${provider('apple')}</div>${message}<p class="auth-switch">Your sites, credits and settings follow your account on every device.</p></div>`;
    gate.scrollTop = 0;
    const film = gate.querySelector('.auth-hero-film');
    if (film && gate.dataset.heroPoster) {
      film.style.backgroundImage = `url("${gate.dataset.heroPoster}")`;
    }
    if (next === 'welcome' || next === 'handoff') startHeroFilm();
    if (next === 'welcome') startHeroCascade();
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
  // A member whose session is saved on this device is not arriving at the front
  // door: the server confirms the session in a moment. Painting the sign-in
  // buttons meanwhile read as having been signed out, on every reload.
  const returning = !arrival.pending && !arrival.error && data?.auth.state().kind === 'member';
  render(arrival.pending ? 'handoff' : returning ? 'restoring' : 'welcome');
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
    if (gate.classList.contains('auth-restoring') || (!gate.classList.contains('auth-welcome') && !gate.classList.contains('auth-email') && !gate.classList.contains('auth-handoff'))) {
      render('welcome');
    }
  }
  data?.account.subscribe(user => {
    // `null` is not the server saying "guest": the live query re-runs
    // unauthenticated while its socket re-authenticates, and treating that as
    // an answer shut a member who had just signed in back out. An anonymous
    // row is a real answer, and still locks.
    if (user === null && confirmed && data.auth.state().kind === 'member') return;
    const member = Boolean(user && !user.isAnonymous);
    confirmed = member;
    // Restoring waits for an answer. A guest row is one: this device's saved
    // session was not a member's after all, so the front door opens.
    if (!member && user && gate.classList.contains('auth-restoring')) render('welcome');
    // A confirmed account still waits for the authoritative website/plan
    // gate. Do not briefly flash the dashboard during sign-in or a reload.
    window.ForgeOnboarding?.setMember(member ? user : null);
    if (!window.ForgeOnboarding) { dashboard.hidden = true; dashboard.inert = true; }
    gate.hidden = member;
    if (member) {
      stopHero();
      window.dispatchEvent(new Event('resize'));
    }
  });
  data?.auth.onChange(state => { if (!state.signedIn || state.kind !== 'member') lock(); });
  // A handoff that fails says so here. It used to fail into the welcome screen
  // with nothing written on it, which reads as "nothing happened".
  data?.auth.onHandoff(({ pending, error }) => {
    if (pending) { if (!gate.classList.contains('auth-handoff')) render('handoff'); return; }
    if (error) { render('welcome'); status(error, true); }
  });
})();
