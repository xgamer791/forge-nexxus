// Marketing pages: header state, the hero composer hand-off, pricing toggle.
(() => {
  const header = document.querySelector('[data-header]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const setScrolled = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
  setScrolled();
  window.addEventListener('scroll', setScrolled, { passive: true });
  toggle?.addEventListener('click', () => {
    const open = !header.classList.contains('nav-open');
    header.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.site-nav a').forEach(link => link.addEventListener('click', () => {
    header?.classList.remove('nav-open');
    toggle?.setAttribute('aria-expanded', 'false');
  }));

  // A member sees "Open Forge" where a visitor sees "Start building". Only the
  // wording changes here; the builder decides for itself who is signed in.
  let member = false;
  try {
    member = localStorage.getItem('forge-auth-kind') === 'member' && Boolean(localStorage.getItem('forge-auth-token'));
  } catch { member = false; }
  if (member) {
    document.documentElement.classList.add('is-member');
    document.querySelectorAll('[data-member-text]').forEach(el => { el.textContent = el.dataset.memberText; });
  }

  // The hero composer is the mobile app's pill. Enter and a typed prompt go
  // to the builder; plus opens the builder (attachments live there); the mic
  // is the same voice input as the app.
  const composer = document.querySelector('[data-hero-composer]');
  const field = composer?.querySelector('textarea');
  const add = composer?.querySelector('[data-hero-add]');
  const microphone = composer?.querySelector('.microphone');
  const restingPlaceholder = 'Describe the site you want…';
  if (composer && field) {
    const root = document.documentElement;
    const keyboardInset = () => {
      const vk = navigator.virtualKeyboard?.boundingRect?.height;
      if (typeof vk === 'number' && vk > 0) return Math.round(vk);
      const viewport = window.visualViewport;
      if (!viewport) return 0;
      return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    };
    let lockedScrollY = 0;
    const holdHero = () => {
      root.style.setProperty('--keyboard', `${keyboardInset()}px`);
    };
    const prepareTyping = () => {
      if (!window.matchMedia('(max-width:899.98px)').matches) return;
      if (root.classList.contains('hero-is-typing')) return;
      lockedScrollY = window.scrollY;
      root.style.setProperty('--locked-scroll-top', `${-lockedScrollY}px`);
      root.classList.add('hero-is-typing');
      try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true; } catch { /* older Chrome */ }
    };
    const startTyping = () => {
      prepareTyping();
      holdHero();
    };
    const stopTyping = () => {
      root.classList.remove('hero-is-typing');
      root.style.setProperty('--keyboard', '0px');
      root.style.removeProperty('--locked-scroll-top');
      window.scrollTo(0, lockedScrollY);
    };
    // iOS decides how far to scroll an input before `focus` fires. Lock the
    // document on the pointer event so that automatic scroll never starts.
    field.addEventListener('pointerdown', prepareTyping);
    field.addEventListener('touchstart', prepareTyping, { passive: true });
    field.addEventListener('focus', startTyping);
    field.addEventListener('blur', stopTyping);
    window.visualViewport?.addEventListener('resize', () => { if (root.classList.contains('hero-is-typing')) holdHero(); });
    navigator.virtualKeyboard?.addEventListener('geometrychange', () => { if (root.classList.contains('hero-is-typing')) holdHero(); });
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
    });
    composer.addEventListener('submit', event => {
      const prompt = field.value.trim();
      if (!prompt) { event.preventDefault(); field.focus({ preventScroll: true }); return; }
      field.value = prompt;
    });
    add?.addEventListener('click', () => {
      const prompt = field.value.trim();
      if (prompt) composer.requestSubmit();
      else location.assign(composer.getAttribute('action') || '/app/');
    });
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition;
    let voicePrefix = '';
    let voiceTranscript = '';
    const setVoiceInputActive = active => {
      microphone?.setAttribute('aria-pressed', String(active));
      microphone?.setAttribute('aria-label', active ? 'Stop voice input' : 'Start voice input');
      field.placeholder = active ? 'Listening…' : restingPlaceholder;
    };
    microphone?.addEventListener('click', () => {
      if (!SpeechRecognition) {
        field.placeholder = 'Voice input is not supported in this browser';
        field.focus({ preventScroll: true });
        return;
      }
      if (microphone.getAttribute('aria-pressed') === 'true') {
        recognition?.stop();
        return;
      }
      recognition ??= new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';
      voicePrefix = field.value.trim();
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
        field.value = `${voicePrefix}${voiceTranscript}${interimTranscript}`.trimEnd();
      };
      recognition.onerror = event => {
        setVoiceInputActive(false);
        if (!field.value) {
          field.placeholder = event.error === 'not-allowed'
            ? 'Enable microphone access to use voice input'
            : 'Voice input unavailable';
        }
      };
      recognition.onend = () => {
        setVoiceInputActive(false);
        field.value = field.value.trimEnd();
        field.focus({ preventScroll: true });
      };
      try { recognition.start(); } catch { setVoiceInputActive(false); }
    });
    window.addEventListener('pagehide', () => recognition?.abort());
  }

  // Monthly / yearly: both prices come with the card from the catalog.
  document.querySelectorAll('[data-interval-toggle]').forEach(group => {
    const section = group.closest('section');
    const plans = section?.querySelector('[data-plans]');
    group.querySelectorAll('[data-interval]').forEach(button => button.addEventListener('click', () => {
      const interval = button.dataset.interval;
      group.querySelectorAll('[data-interval]').forEach(item => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      if (!plans) return;
      plans.dataset.interval = interval;
      plans.querySelectorAll('[data-price-month]').forEach(price => {
        price.textContent = interval === 'year' ? price.dataset.priceYear : price.dataset.priceMonth;
      });
      plans.querySelectorAll('[data-billing-month]').forEach(el => { el.hidden = interval !== 'month'; });
      plans.querySelectorAll('[data-billing-year]').forEach(el => { el.hidden = interval !== 'year'; });
    }));
  });
})();
