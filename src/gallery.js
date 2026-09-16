const galleries = new WeakMap();
const SPEED = 30;
let gallerySequence = 0;

function bindGallery(gallery) {
  const track = gallery.querySelector('.gallery-track');
  if (!track) return () => {};

  const previous = gallery.querySelector('[data-gallery-prev]');
  const next = gallery.querySelector('[data-gallery-next]');
  const toggle = gallery.querySelector('[data-gallery-toggle]');
  const videos = [...track.querySelectorAll('video[data-src]')];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const listeners = { signal: controller.signal };
  const media = new Map();
  let visible = false, hovered = false, focused = false, interactionPaused = false;
  let userChoice = null, direction = 1, frame = null, lastFrame = null, destroyed = false;
  let scrollPosition = null, allowFocusedPlay = false, allowHoveredPlay = false;
  let trackObserver, videoObserver, resizeObserver;
  const originalSnap = track.style.scrollSnapType;
  const originalBehavior = track.style.scrollBehavior;

  if (!track.id) track.id = `example-gallery-${++gallerySequence}`;
  if (!track.hasAttribute('tabindex')) track.tabIndex = 0;
  if (!gallery.hasAttribute('role')) gallery.setAttribute('role', 'region');
  if (!gallery.hasAttribute('aria-label') && !gallery.hasAttribute('aria-labelledby')) gallery.setAttribute('aria-label', 'Example gallery');
  gallery.setAttribute('aria-roledescription', 'carousel');
  track.setAttribute('aria-live', 'off');
  for (const [button, label] of [[previous, 'Previous examples'], [next, 'Next examples']]) {
    if (!button) continue;
    button.type = 'button'; button.setAttribute('aria-label', label);
    button.setAttribute('aria-controls', track.id);
    if (!button.textContent.trim()) button.textContent = label;
  }
  if (toggle) { toggle.type = 'button'; toggle.setAttribute('aria-controls', track.id); }

  const globallyPaused = () => userChoice === 'pause' || (userChoice === null && motion.matches);
  const maximum = () => Math.max(0, track.scrollWidth - track.clientWidth);
  const canScroll = () => !destroyed && visible && !document.hidden && !globallyPaused() && !interactionPaused && (!hovered || allowHoveredPlay) && (!focused || allowFocusedPlay) && maximum() > 1;
  const canPlay = state => !destroyed && visible && state.visible && !document.hidden && !globallyPaused() && !state.userPaused && !state.failed && !state.blocked;

  function pauseVideo(video, state) {
    if (video.paused) return;
    state.expectedPauses++;
    video.pause();
  }

  function syncVideo(video, state) {
    if (!canPlay(state)) { pauseVideo(video, state); return; }
    if (!state.loaded) {
      // A visible video receives its own source once; media is never cloned.
      const source = video.dataset.src;
      if (!source) return;
      video.src = source; state.loaded = true; video.preload = 'metadata';
      video.load();
    }
    if (!video.paused || state.playPending) return;
    state.playPending = true;
    try {
      Promise.resolve(video.play()).catch(() => { state.blocked = true; }).finally(() => {
        state.playPending = false;
        if (!canPlay(state)) pauseVideo(video, state);
      });
    } catch { state.playPending = false; state.blocked = true; }
  }

  function updateControls() {
    const max = maximum();
    if (previous) previous.disabled = max <= 1 || track.scrollLeft <= 1;
    if (next) next.disabled = max <= 1 || track.scrollLeft >= max - 1;
    if (toggle) {
      const paused = globallyPaused() || interactionPaused;
      const label = paused ? 'Play gallery' : 'Pause gallery';
      if (toggle.textContent !== label) toggle.textContent = label;
      const ariaLabel = paused ? 'Play gallery motion' : 'Pause gallery motion';
      if (toggle.getAttribute('aria-label') !== ariaLabel) toggle.setAttribute('aria-label', ariaLabel);
      if (toggle.getAttribute('aria-pressed') !== String(paused)) toggle.setAttribute('aria-pressed', String(paused));
    }
  }

  function stopFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; lastFrame = null; scrollPosition = null;
    track.style.scrollSnapType = originalSnap;
    track.style.scrollBehavior = originalBehavior;
  }

  function animate(time) {
    frame = null;
    if (!canScroll()) { stopFrame(); return; }
    const elapsed = lastFrame === null ? 0 : Math.min((time - lastFrame) / 1000, 0.1);
    lastFrame = time;
    const max = maximum();
    // Retain subpixel progress even in browsers that round scrollLeft on writes.
    let position = (scrollPosition ?? track.scrollLeft) + direction * SPEED * elapsed;
    if (position >= max) { position = max; direction = -1; }
    else if (position <= 0) { position = 0; direction = 1; }
    scrollPosition = position; track.scrollLeft = position;
    updateControls();
    frame = requestAnimationFrame(animate);
  }

  function wake() {
    for (const [video, state] of media) syncVideo(video, state);
    updateControls();
    if (!canScroll()) { stopFrame(); return; }
    if (frame === null) {
      // Native scrolling remains available; snap points must not fight the slow pan.
      track.style.scrollSnapType = 'none'; track.style.scrollBehavior = 'auto';
      frame = requestAnimationFrame(animate);
    }
  }

  function manualNavigation() {
    // Swiping, wheel scrolling, and arrow navigation stop the automatic pan until
    // Play gallery is chosen. Visible videos keep playing so they can be inspected.
    interactionPaused = true; wake();
  }

  function move(amount) {
    manualNavigation();
    track.scrollBy({ left: amount * Math.max(160, track.clientWidth * 0.8), behavior: motion.matches ? 'auto' : 'smooth' });
  }

  previous?.addEventListener('click', () => move(-1), listeners);
  next?.addEventListener('click', () => move(1), listeners);
  toggle?.addEventListener('click', () => {
    const paused = globallyPaused() || interactionPaused;
    userChoice = paused ? 'play' : 'pause'; interactionPaused = false;
    // Play is an explicit request even while its control still has focus/hover.
    // The next focus navigation or fresh pointer entry reinstates normal pauses.
    allowFocusedPlay = paused && focused; allowHoveredPlay = paused && hovered;
    if (paused) for (const state of media.values()) state.blocked = false;
    // Explicit Play is allowed after a reduced-motion default; an individual
    // video's native Pause is preserved until the user plays that video again.
    wake();
  }, listeners);
  gallery.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { hovered = true; allowHoveredPlay = false; wake(); } }, listeners);
  gallery.addEventListener('pointerleave', () => { hovered = false; allowHoveredPlay = false; wake(); }, listeners);
  gallery.addEventListener('focusin', () => { focused = true; allowFocusedPlay = false; wake(); }, listeners);
  gallery.addEventListener('focusout', () => { allowFocusedPlay = false; queueMicrotask(() => { focused = gallery.contains(document.activeElement); wake(); }); }, listeners);
  track.addEventListener('pointerdown', manualNavigation, { ...listeners, passive: true });
  track.addEventListener('touchstart', manualNavigation, { ...listeners, passive: true });
  track.addEventListener('wheel', manualNavigation, { ...listeners, passive: true });
  track.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) manualNavigation();
  }, listeners);
  document.addEventListener('visibilitychange', wake, listeners);

  for (const video of videos) {
    const state = { visible: false, loaded: false, userPaused: false, blocked: false, failed: false, playPending: false, expectedPauses: 0 };
    media.set(video, state);
    video.autoplay = false; video.removeAttribute('autoplay'); video.preload = 'none';
    video.muted = true; video.defaultMuted = true; video.loop = true; video.playsInline = true;
    video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
    video.addEventListener('pause', () => {
      if (state.expectedPauses) { state.expectedPauses--; return; }
      state.userPaused = true;
    }, listeners);
    video.addEventListener('play', () => {
      state.userPaused = false;
      if (!canPlay(state)) pauseVideo(video, state);
    }, listeners);
    video.addEventListener('error', () => { state.failed = true; }, listeners);
    pauseVideo(video, state);
  }

  function checkFallbackVisibility() {
    const bounds = track.getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    visible = bounds.right > 0 && bounds.left < width && bounds.bottom > 0 && bounds.top < height;
    for (const [video, state] of media) {
      const rect = video.getBoundingClientRect();
      state.visible = Math.min(rect.right, bounds.right, width) > Math.max(rect.left, bounds.left, 0) &&
        Math.min(rect.bottom, bounds.bottom, height) > Math.max(rect.top, bounds.top, 0);
    }
    wake();
  }

  if (typeof IntersectionObserver === 'function') {
    trackObserver = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.target === track && entry.isIntersecting && entry.intersectionRatio > 0);
      wake();
    }, { threshold: [0, 0.05] });
    trackObserver.observe(track);
    videoObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = media.get(entry.target);
        if (state) { state.visible = entry.isIntersecting && entry.intersectionRatio >= 0.15; syncVideo(entry.target, state); }
      }
    }, { threshold: [0, 0.15, 0.5], rootMargin: '0px' });
    for (const video of videos) videoObserver.observe(video);
    track.addEventListener('scroll', updateControls, { ...listeners, passive: true });
  } else {
    window.addEventListener('scroll', checkFallbackVisibility, { ...listeners, passive: true });
    track.addEventListener('scroll', checkFallbackVisibility, { ...listeners, passive: true });
    checkFallbackVisibility();
  }

  const resized = () => trackObserver ? wake() : checkFallbackVisibility();
  window.addEventListener('resize', resized, { ...listeners, passive: true });
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(resized);
    resizeObserver.observe(track);
    for (const child of track.children) resizeObserver.observe(child);
  }
  const preferenceChanged = () => { if (motion.matches && userChoice === 'play') userChoice = null; wake(); };
  if (motion.addEventListener) motion.addEventListener('change', preferenceChanged, listeners);
  else motion.addListener(preferenceChanged);
  updateControls();

  return () => {
    destroyed = true;
    controller.abort(); stopFrame();
    trackObserver?.disconnect(); videoObserver?.disconnect(); resizeObserver?.disconnect();
    if (!motion.addEventListener) motion.removeListener(preferenceChanged);
    for (const [video, state] of media) pauseVideo(video, state);
    galleries.delete(gallery);
  };
}

export function initGalleries() {
  const active = [];
  for (const gallery of document.querySelectorAll('[data-gallery]')) {
    if (!galleries.has(gallery)) galleries.set(gallery, bindGallery(gallery));
    active.push(galleries.get(gallery));
  }
  return () => active.forEach(cleanup => cleanup());
}
