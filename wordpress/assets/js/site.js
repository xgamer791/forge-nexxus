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

  // Native loop seeks the visible element and flashes a hold. Two unlocked
  // layers trade places before the file ends; the visible one never seeks.
  const heroLoops = [...document.querySelectorAll('[data-hero-loop]')];
  if (heroLoops.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const lead = 0.22;
    let active = heroLoops[0];
    let standby = heroLoops[1] || null;
    let switching = false;

    const play = video => {
      if (!video) return Promise.resolve();
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.loop = false;
      const run = video.play();
      return run ? run.catch(() => {}) : Promise.resolve();
    };

    const rewind = video => {
      if (!video) return;
      try {
        if (video.currentTime > 0.02) video.currentTime = 0;
      } catch { /* iOS can reject a seek until metadata is ready */ }
    };

    const arm = video => {
      if (!video) return;
      rewind(video);
      play(video).then(() => {
        if (video !== active) video.pause();
        rewind(video);
      });
    };

    const swap = () => {
      if (switching) return;
      switching = true;
      const outgoing = active;
      const incoming = standby || active;
      let revealed = false;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        incoming.classList.add('is-active');
        if (incoming !== outgoing) outgoing.classList.remove('is-active');
        active = incoming;
        standby = incoming === outgoing ? null : outgoing;
        requestAnimationFrame(() => {
          if (standby) {
            standby.pause();
            rewind(standby);
          } else {
            rewind(active);
            play(active);
          }
          switching = false;
        });
      };
      play(incoming).then(() => {
        if (incoming.readyState >= 2 && !incoming.paused) reveal();
        else incoming.addEventListener('playing', reveal, { once: true });
      });
      setTimeout(reveal, 180);
    };

    const remaining = video => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration < 0.5) return Infinity;
      return duration - video.currentTime;
    };

    const consider = () => {
      if (switching) return;
      if (active.ended || remaining(active) <= lead) swap();
    };

    heroLoops.forEach(video => {
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.loop = false;
      video.addEventListener('ended', () => {
        if (video === active) swap();
        else arm(video);
      });
      video.addEventListener('timeupdate', () => { if (video === active) consider(); });
      video.addEventListener('stalled', () => { if (video === active) play(video); });
      video.addEventListener('waiting', () => { if (video === active) play(video); });
    });

    play(active);
    arm(standby);

    const clock = () => {
      consider();
      requestAnimationFrame(clock);
    };
    requestAnimationFrame(clock);

    const resume = () => play(active);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    setInterval(() => { if (active.paused || active.ended) play(active); }, 1000);
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
    const visibleBottom = () => {
      const keyboard = navigator.virtualKeyboard?.boundingRect;
      if (keyboard && keyboard.height > 0) return keyboard.y;
      const viewport = window.visualViewport;
      return viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    };
    let lockedScrollY = 0;
    const holdHero = () => {
      // Start each measurement from the composer's real place in the hero,
      // then move only the portion that the keyboard would cover.
      root.style.setProperty('--composer-shift', '0px');
      const overlap = composer.getBoundingClientRect().bottom + 25 - visibleBottom();
      root.style.setProperty('--composer-shift', `${Math.min(0, -Math.max(0, Math.round(overlap)))}px`);
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
      root.style.setProperty('--composer-shift', '0px');
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
