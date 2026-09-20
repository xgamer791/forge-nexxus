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

  // The hero composer hands the prompt to the builder; sign-in happens there
  // and the prompt is waiting in the composer afterwards.
  const composer = document.querySelector('[data-hero-composer]');
  const field = composer?.querySelector('textarea');
  if (composer && field) {
    const grow = () => { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 200)}px`; };
    field.addEventListener('input', grow);
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
    });
    composer.addEventListener('submit', event => {
      const prompt = field.value.trim();
      if (!prompt) { event.preventDefault(); field.focus(); return; }
      field.value = prompt;
    });
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
