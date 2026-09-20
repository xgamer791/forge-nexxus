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

  // The generated clip settles at both matching endpoint frames. Two primed
  // layers skip those holds and crossfade before the file ends, so iOS never
  // has to stop, seek and decode before the next visible frame.
  const heroLoops = [...document.querySelectorAll('[data-hero-loop]')];
  if (heroLoops.length === 2 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const loopStart = 0.5;
    const loopEndPadding = 0.5;
    const crossfadeMs = 140;
    let active = heroLoops[0];
    let standby = heroLoops[1];
    let switching = false;

    const prime = video => {
      const seek = () => {
        video.currentTime = Math.min(loopStart, Math.max(0, video.duration - loopEndPadding));
      };
      if (video.readyState >= 1) seek();
      else video.addEventListener('loadedmetadata', seek, { once: true });
    };
    prime(active);
    prime(standby);

    const swap = async () => {
      if (switching) return;
      switching = true;
      const previous = active;
      const next = standby;
      try {
        await next.play();
        next.classList.add('is-active');
        previous.classList.remove('is-active');
        active = next;
        standby = previous;
        setTimeout(() => {
          standby.pause();
          prime(standby);
          switching = false;
        }, crossfadeMs);
      } catch {
        switching = false;
      }
    };

    const follow = () => {
      if (
        !switching &&
        Number.isFinite(active.duration) &&
        active.currentTime >= active.duration - loopEndPadding
      ) swap();
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }

  // Cycle the five homepage promises through one word-cascade stage. The
  // first message gets a longer hold after a complete pass so the loop has a
  // clear resting point instead of feeling continuously busy.
  const messageStage = document.querySelector('[data-hero-messages]');
  const heroMessages = [...(messageStage?.querySelectorAll('.hero-message') || [])];
  if (heroMessages.length) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wordDelayMs = 72;
    const wordEnterMs = 580;
    const exitMs = 320;
    const regularHoldMs = 1300;
    const returningFirstHoldMs = 3600;
    let stopped = false;

    heroMessages.forEach(message => {
      const words = message.textContent.trim().split(/\s+/);
      const fragment = document.createDocumentFragment();
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.className = 'hero-message-word';
        span.style.setProperty('--word-index', String(index));
        span.textContent = word;
        fragment.append(span);
      });
      message.replaceChildren(fragment);
      message.classList.remove('is-active', 'is-leaving');
      message.dataset.wordCount = String(words.length);
    });

    if (reducedMotion) {
      heroMessages[0].classList.add('is-active');
    } else {
      const wait = duration => new Promise(resolve => setTimeout(resolve, duration));
      const playMessages = async () => {
        let index = 0;
        let completedPass = false;
        while (!stopped) {
          const message = heroMessages[index];
          message.classList.remove('is-leaving');
          await wait(40);
          if (stopped) break;
          message.classList.add('is-active');

          const wordCount = Number(message.dataset.wordCount) || 1;
          await wait(wordEnterMs + ((wordCount - 1) * wordDelayMs));
          await wait(index === 0 && completedPass ? returningFirstHoldMs : regularHoldMs);
          if (stopped) break;

          message.classList.remove('is-active');
          message.classList.add('is-leaving');
          await wait(exitMs);
          message.classList.remove('is-leaving');

          index += 1;
          if (index === heroMessages.length) {
            index = 0;
            completedPass = true;
          }
        }
      };
      void playMessages();
      window.addEventListener('pagehide', () => { stopped = true; }, { once: true });
    }
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
