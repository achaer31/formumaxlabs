const initialized = new WeakMap();

function bindAnimatedMedia(container) {
  const images = [...container.querySelectorAll('img[data-gif-src]')];
  if (!images.length) return () => {};
  const toggle = container.querySelector('[data-motion-toggle]');
  const galleryToggle = container.closest('[data-gallery]')?.querySelector('[data-gallery-toggle]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const listeners = { signal: controller.signal };
  const states = new Map();
  let observer, galleryObserver, choice = null, galleryPlayOverride = false, destroyed = false;
  let galleryWasPaused = galleryToggle?.getAttribute('aria-pressed') === 'true';

  const galleryPaused = () => galleryToggle?.getAttribute('aria-pressed') === 'true';
  const prefersPoster = () => choice === 'pause' || (choice !== 'play' && motion.matches && !galleryPlayOverride);

  function lockAspect(image, state) {
    if (image.style.aspectRatio) return;
    const width = Number(image.getAttribute('width')) || image.naturalWidth;
    const height = Number(image.getAttribute('height')) || image.naturalHeight;
    if (width > 0 && height > 0) { image.style.aspectRatio = `${width} / ${height}`; state.aspectLocked = true; }
  }

  function showPoster(image, state) {
    if (state.active) {
      state.active = false;
      image.src = state.poster;
      for (const [name, value] of [['srcset', state.srcset], ['sizes', state.sizes]]) {
        if (value === null) image.removeAttribute(name); else image.setAttribute(name, value);
      }
    }
    image.dataset.animationState = state.blocked ? 'unavailable' : 'poster';
  }

  function updateControls() {
    if (!toggle) return;
    const blocked = [...states.values()].every(state => state.blocked);
    const paused = prefersPoster() || galleryPaused() || blocked;
    toggle.type = 'button';
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
    toggle.setAttribute('aria-label', toggle.textContent);
    toggle.setAttribute('aria-pressed', String(paused));
    const unavailable = [...states.values()].every(state => !state.validSource);
    toggle.disabled = Boolean(galleryPaused() || unavailable);
    toggle.title = galleryPaused() ? 'Choose Play gallery to enable animation.' : unavailable ? 'Animation unavailable.' : blocked ? 'Animation could not load. Select to retry.' : '';
  }

  function synchronize() {
    for (const [image, state] of states) {
      const play = !destroyed && state.visible && !document.hidden && !prefersPoster() && !galleryPaused() && !state.blocked;
      if (!play) { showPoster(image, state); continue; }
      if (state.active) continue;
      lockAspect(image, state);
      // GIF pixels animate natively. Restoring the poster stops that animation;
      // restarting the GIF is intentional and does not promise frame-level pause.
      state.active = true;
      image.removeAttribute('srcset'); image.removeAttribute('sizes');
      image.dataset.animationState = 'loading';
      image.src = state.gif;
    }
    updateControls();
  }

  for (const image of images) {
    const state = {
      poster: image.getAttribute('src') || '', gif: image.dataset.gifSrc || '',
      srcset: image.getAttribute('srcset'), sizes: image.getAttribute('sizes'),
      originalAspect: image.style.aspectRatio, aspectLocked: false,
      visible: false, active: false, blocked: false, validSource: true,
    };
    try {
      const source = new URL(state.gif, location.href);
      if (!['https:', 'http:'].includes(source.protocol) || !source.pathname.toLowerCase().endsWith('.gif') || !state.poster) state.validSource = false;
    } catch { state.validSource = false; }
    state.blocked = !state.validSource;
    states.set(image, state);
    lockAspect(image, state);
    image.addEventListener('load', () => {
      lockAspect(image, state);
      if (state.active) image.dataset.animationState = 'playing';
    }, listeners);
    image.addEventListener('error', () => {
      if (!state.active) return;
      state.blocked = true; synchronize();
    }, listeners);
  }

  toggle?.addEventListener('click', () => {
    if (galleryPaused()) return;
    const blocked = [...states.values()].every(state => state.blocked);
    choice = prefersPoster() || blocked ? 'play' : 'pause';
    if (choice === 'play') for (const state of states.values()) if (state.validSource) state.blocked = false;
    synchronize();
  }, listeners);
  document.addEventListener('visibilitychange', synchronize, listeners);

  if (galleryToggle && typeof MutationObserver === 'function') {
    galleryObserver = new MutationObserver(() => {
      const paused = galleryPaused();
      if (galleryWasPaused && !paused) galleryPlayOverride = true;
      if (paused) galleryPlayOverride = false;
      galleryWasPaused = paused;
      synchronize();
    });
    galleryObserver.observe(galleryToggle, { attributes: true, attributeFilter: ['aria-pressed'] });
  }

  const preferenceChanged = () => {
    if (motion.matches) { if (choice === 'play') choice = null; galleryPlayOverride = false; }
    synchronize();
  };
  if (motion.addEventListener) motion.addEventListener('change', preferenceChanged, listeners);
  else motion.addListener(preferenceChanged);

  function updateFallbackVisibility() {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    for (const [image, state] of states) {
      const rect = image.getBoundingClientRect();
      const clip = image.closest('.gallery-track')?.getBoundingClientRect() || { left: 0, top: 0, right: width, bottom: height };
      state.visible = Math.min(rect.right, clip.right, width) > Math.max(rect.left, clip.left, 0) &&
        Math.min(rect.bottom, clip.bottom, height) > Math.max(rect.top, clip.top, 0);
    }
    synchronize();
  }

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (state) state.visible = entry.isIntersecting && entry.intersectionRatio >= 0.1;
      }
      synchronize();
    }, { threshold: [0, 0.1], rootMargin: '0px' });
    for (const image of images) observer.observe(image);
  } else {
    window.addEventListener('scroll', updateFallbackVisibility, { ...listeners, passive: true, capture: true });
    window.addEventListener('resize', updateFallbackVisibility, { ...listeners, passive: true });
    updateFallbackVisibility();
  }
  synchronize();

  return () => {
    destroyed = true; synchronize(); controller.abort();
    observer?.disconnect(); galleryObserver?.disconnect();
    if (!motion.addEventListener) motion.removeListener(preferenceChanged);
    for (const [image, state] of states) if (state.aspectLocked) image.style.aspectRatio = state.originalAspect;
    initialized.delete(container);
  };
}

export function initAnimatedMedia() {
  const active = [];
  for (const container of document.querySelectorAll('[data-animated-media]')) {
    if (!initialized.has(container)) initialized.set(container, bindAnimatedMedia(container));
    active.push(initialized.get(container));
  }
  return () => active.forEach(cleanup => cleanup());
}
