const initialized = new WeakMap();
let sharedVisibility;

// One pair of observers serves every animation, including clips inside scroll
// tracks. A distant card has neither a poster request nor a video request.
function visibilityObservers() {
  if (sharedVisibility) return sharedVisibility;
  const callbacks = new Map();
  const controller = new AbortController();
  let posters, playback;
  function checkFallback() {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    for (const [media, callback] of callbacks) {
      const rect = media.getBoundingClientRect();
      const clip = media.closest('.gallery-track')?.getBoundingClientRect() || { left: 0, top: 0, right: width, bottom: height };
      const intersectionWidth = Math.max(0, Math.min(rect.right, clip.right, width) - Math.max(rect.left, clip.left, 0));
      const intersectionHeight = Math.max(0, Math.min(rect.bottom, clip.bottom, height) - Math.max(rect.top, clip.top, 0));
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      const near = rect.right > Math.max(clip.left, 0) - 200 && rect.left < Math.min(clip.right, width) + 200 &&
        rect.bottom > Math.max(clip.top, 0) - 200 && rect.top < Math.min(clip.bottom, height) + 200;
      if (near) callback.poster();
      callback.visible(area > 0 && intersectionWidth * intersectionHeight / area >= 0.1);
    }
  }
  if (typeof IntersectionObserver === 'function') {
    posters = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) callbacks.get(entry.target)?.poster();
    }, { threshold: 0, rootMargin: '200px' });
    playback = new IntersectionObserver(entries => {
      for (const entry of entries) callbacks.get(entry.target)?.visible(entry.isIntersecting && entry.intersectionRatio >= 0.1);
    }, { threshold: [0, 0.1], rootMargin: '0px' });
  } else {
    window.addEventListener('scroll', checkFallback, { signal: controller.signal, passive: true, capture: true });
    window.addEventListener('resize', checkFallback, { signal: controller.signal, passive: true });
  }
  sharedVisibility = {
    observe(media, callback) {
      callbacks.set(media, callback);
      if (posters) { posters.observe(media); playback.observe(media); } else checkFallback();
      return () => {
        callbacks.delete(media); posters?.unobserve(media); playback?.unobserve(media);
        if (!callbacks.size) { posters?.disconnect(); playback?.disconnect(); controller.abort(); sharedVisibility = null; }
      };
    },
  };
  return sharedVisibility;
}

function bindAnimatedMedia(container) {
  const media = [...container.querySelectorAll('img[data-gif-src], video[data-loop-src]')];
  if (!media.length) return () => {};
  let toggle = container.querySelector('[data-motion-toggle]');
  let generatedToggle = false;
  if (!toggle && media.some(element => element.tagName === 'VIDEO')) {
    toggle = document.createElement('button');
    toggle.setAttribute('data-motion-toggle', '');
    toggle.className = 'motion-fallback-control'; toggle.hidden = true;
    container.append(toggle); generatedToggle = true;
  }
  const galleryToggle = container.closest('[data-gallery]')?.querySelector('[data-gallery-toggle]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const listeners = { signal: controller.signal };
  const states = new Map();
  const unobserve = [];
  let galleryObserver, choice = null, galleryPlayOverride = false, destroyed = false;
  let galleryWasPaused = galleryToggle?.getAttribute('aria-pressed') === 'true';

  const prefersPoster = () => choice === 'pause' || (choice !== 'play' && motion.matches && !galleryPlayOverride);
  const wantsPlayback = state => !destroyed && state.visible && !document.hidden && !prefersPoster() && !state.blocked;

  function lockAspect(element, state) {
    if (element.style.aspectRatio) return;
    const width = Number(element.getAttribute('width')) || element.naturalWidth;
    const height = Number(element.getAttribute('height')) || element.naturalHeight;
    if (width > 0 && height > 0) { element.style.aspectRatio = `${width} / ${height}`; state.aspectLocked = true; }
  }

  function ensurePoster(element, state) {
    if (state.video && !state.posterLoaded && state.poster) {
      element.poster = state.poster; state.posterLoaded = true;
    }
  }

  function showPoster(element, state) {
    if (state.video) {
      state.epoch++;
      if (!element.paused) element.pause();
      state.active = false;
      element.preload = 'none';
    } else if (state.active) {
      state.active = false; element.src = state.poster;
      for (const [name, value] of [['srcset', state.srcset], ['sizes', state.sizes]]) {
        if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
      }
    }
    element.dataset.animationState = state.blocked ? 'unavailable' : 'poster';
  }

  function updateControls() {
    if (!toggle) return;
    const blocked = [...states.values()].some(state => state.blocked);
    const paused = prefersPoster() || blocked;
    toggle.type = 'button';
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
    toggle.setAttribute('aria-label', toggle.textContent);
    toggle.setAttribute('aria-pressed', String(paused));
    const unavailable = [...states.values()].every(state => !state.validSource);
    toggle.disabled = unavailable;
    toggle.title = unavailable ? 'Animation unavailable.' : blocked ? 'Animation could not start. Select to retry.' : '';
    if (generatedToggle) toggle.hidden = !paused;
  }

  function playbackFailed(element, state) {
    state.blocked = true;
    showPoster(element, state);
    // Reset a failed or rejected player to its lightweight poster. Leaving a
    // failed media source attached can otherwise leave a blank frame on iOS.
    if (state.video && state.loaded) {
      element.removeAttribute('src'); element.load(); state.loaded = false;
    }
    updateControls();
  }

  function startVideo(element, state) {
    if (state.pending || (!element.paused && state.active)) return;
    ensurePoster(element, state);
    if (!state.loaded) {
      element.src = state.source; element.preload = 'metadata';
      state.loaded = true; element.load();
    }
    state.pending = true;
    const epoch = state.epoch;
    element.dataset.animationState = 'loading';
    const settle = error => {
      state.pending = false;
      // A pending play may finish after a swipe, hide, or explicit pause. It
      // cannot revive that clip or treat our cancellation as autoplay failure.
      if (epoch !== state.epoch || !wantsPlayback(state)) {
        if (!element.paused) element.pause();
        if (wantsPlayback(state)) synchronize();
        return;
      }
      if (error) { playbackFailed(element, state); return; }
      state.active = true; element.dataset.animationState = 'playing'; updateControls();
    };
    try { Promise.resolve(element.play()).then(() => settle(), error => settle(error)); }
    catch (error) { settle(error); }
  }

  function synchronize() {
    for (const [element, state] of states) {
      if (!wantsPlayback(state)) { showPoster(element, state); continue; }
      if (state.video) { startVideo(element, state); continue; }
      if (state.active) continue;
      lockAspect(element, state);
      state.active = true;
      element.removeAttribute('srcset'); element.removeAttribute('sizes');
      element.dataset.animationState = 'loading'; element.src = state.source;
    }
    updateControls();
  }

  for (const element of media) {
    const video = element.tagName === 'VIDEO';
    const state = {
      video, poster: video ? element.dataset.poster || element.getAttribute('poster') || '' : element.getAttribute('src') || '',
      source: video ? element.dataset.loopSrc || '' : element.dataset.gifSrc || '',
      srcset: element.getAttribute('srcset'), sizes: element.getAttribute('sizes'),
      originalAspect: element.style.aspectRatio, aspectLocked: false,
      visible: false, active: false, blocked: false, validSource: true,
      loaded: false, pending: false, epoch: 0, posterLoaded: Boolean(video && element.getAttribute('poster')),
    };
    try {
      const source = new URL(state.source, location.href);
      if (!['https:', 'http:'].includes(source.protocol) || !source.pathname.toLowerCase().endsWith(video ? '.mp4' : '.gif') || !state.poster) state.validSource = false;
    } catch { state.validSource = false; }
    state.blocked = !state.validSource;
    states.set(element, state); lockAspect(element, state);
    if (video) {
      element.autoplay = false; element.removeAttribute('autoplay'); element.preload = 'none';
      element.muted = true; element.defaultMuted = true; element.loop = true; element.playsInline = true;
      element.setAttribute('muted', ''); element.setAttribute('playsinline', '');
      element.addEventListener('error', () => { if (state.loaded && !destroyed) playbackFailed(element, state); }, listeners);
    } else {
      element.addEventListener('load', () => { lockAspect(element, state); if (state.active) element.dataset.animationState = 'playing'; }, listeners);
      element.addEventListener('error', () => { if (state.active) playbackFailed(element, state); }, listeners);
    }
  }

  function retryPlayback() {
    for (const state of states.values()) if (state.validSource) state.blocked = false;
  }
  toggle?.addEventListener('click', () => {
    const blocked = [...states.values()].some(state => state.blocked);
    choice = prefersPoster() || blocked ? 'play' : 'pause';
    if (choice === 'play') retryPlayback();
    synchronize();
  }, listeners);
  document.addEventListener('visibilitychange', synchronize, listeners);

  if (galleryToggle && typeof MutationObserver === 'function') {
    galleryObserver = new MutationObserver(() => {
      const paused = galleryToggle.getAttribute('aria-pressed') === 'true';
      // Automatic scrolling and clip playback are independent. Starting scroll
      // also provides an explicit retry after a blocked autoplay attempt.
      if (galleryWasPaused && !paused) { galleryPlayOverride = true; retryPlayback(); }
      galleryWasPaused = paused; synchronize();
    });
    galleryObserver.observe(galleryToggle, { attributes: true, attributeFilter: ['aria-pressed'] });
  }

  const preferenceChanged = () => {
    if (motion.matches) { if (choice === 'play') choice = null; galleryPlayOverride = false; }
    synchronize();
  };
  if (motion.addEventListener) motion.addEventListener('change', preferenceChanged, listeners);
  else motion.addListener(preferenceChanged);

  const visibility = visibilityObservers();
  for (const [element, state] of states) unobserve.push(visibility.observe(element, {
    poster: () => ensurePoster(element, state),
    visible: value => { state.visible = value; if (value) ensurePoster(element, state); synchronize(); },
  }));
  synchronize();

  return () => {
    if (destroyed) return;
    destroyed = true; synchronize(); controller.abort();
    unobserve.forEach(stop => stop()); galleryObserver?.disconnect();
    if (!motion.addEventListener) motion.removeListener(preferenceChanged);
    for (const [element, state] of states) {
      if (state.aspectLocked) element.style.aspectRatio = state.originalAspect;
      if (state.video && state.loaded) { element.removeAttribute('src'); element.load(); }
    }
    if (generatedToggle) toggle.remove();
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
