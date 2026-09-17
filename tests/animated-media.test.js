import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const globals = ['window', 'document', 'location', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let sequence = 0;
afterEach(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

async function setup({ reduced = false, inGallery = false, gif = '/assets/animations/scene.gif', kind = 'gif', count = 1, withToggle = true, playBehavior } = {}) {
  const intersections = [], mutations = [];
  class Element {
    constructor(tagName = 'DIV') { this.tagName = tagName; this.handlers = new Map(); this.attributes = new Map(); this.style = {}; this.dataset = {}; this.writes = 0; this.children = []; this.textContent = ''; this.hidden = false; }
    addEventListener(name, callback, options = {}) {
      if (!this.handlers.has(name)) this.handlers.set(name, []);
      this.handlers.get(name).push(callback);
      options.signal?.addEventListener('abort', () => this.handlers.set(name, this.handlers.get(name).filter(item => item !== callback)), { once: true });
    }
    emit(name) { for (const callback of this.handlers.get(name) || []) callback(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    contains(element) { return element === this || this.children.includes(element); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); for (const observer of mutations) if (observer.target === this) observer.callback(); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(element) { this.children.push(element); element.parent = this; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    get src() { return this.getAttribute('src'); }
    set src(value) { this.writes++; this.setAttribute('src', value); }
    get poster() { return this.getAttribute('poster'); }
    set poster(value) { this.setAttribute('poster', value); }
  }
  const galleryToggle = new Element('BUTTON'), gallery = new Element(), track = new Element();
  const containers = [], items = [];
  for (let i = 0; i < count; i++) {
    const container = new Element(), image = new Element(kind === 'video' ? 'VIDEO' : 'IMG');
    const toggle = withToggle ? new Element('BUTTON') : null;
    image.setAttribute('width', '640'); image.setAttribute('height', '360');
    image.closest = () => inGallery ? track : null;
    if (kind === 'video') {
      image.dataset.loopSrc = '/assets/animations/scene.mp4'; image.dataset.poster = '/assets/animations/scene.jpg';
      image.paused = true; image.loadCalls = 0; image.playCalls = 0; image.pauseCalls = 0;
      image.load = () => { image.loadCalls++; image.paused = true; };
      image.playBehavior = playBehavior;
      image.play = () => { image.playCalls++; image.paused = false; return image.playBehavior ? image.playBehavior() : Promise.resolve(); };
      image.pause = () => { image.pauseCalls++; image.paused = true; };
    } else {
      image.setAttribute('src', '/assets/animations/scene.jpg'); image.setAttribute('srcset', '/assets/animations/scene@2x.jpg 2x'); image.dataset.gifSrc = gif;
    }
    container.querySelectorAll = () => [image]; container.querySelector = () => toggle || container.children.find(child => child.hasAttribute('data-motion-toggle')) || null;
    container.closest = () => inGallery ? gallery : null;
    containers.push(container); items.push({ image, toggle, container });
  }
  track.clientWidth = 400; track.scrollWidth = 1000; track.scrollLeft = 0; track.children = items.map(item => item.image);
  track.querySelectorAll = () => [];
  gallery.querySelector = selector => ({ '.gallery-track': track, '[data-gallery-toggle]': galleryToggle })[selector];
  galleryToggle.setAttribute('aria-pressed', String(reduced));
  const doc = new Element(); doc.hidden = false; doc.createElement = tag => new Element(tag.toUpperCase());
  doc.querySelectorAll = selector => selector === '[data-gallery]' ? (inGallery ? [gallery] : []) : containers;
  const motion = new Element(); motion.matches = reduced;
  const win = new Element(); win.matchMedia = () => motion;
  class Intersection {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); intersections.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  class Mutation { constructor(callback) { this.callback = callback; mutations.push(this); } observe(target) { this.target = target; } disconnect() { this.target = null; } }
  const frames = new Map(); let nextFrame = 0;
  for (const [name, value] of Object.entries({ window: win, document: doc, location: { href: 'https://formumaxlabs.com/ultimatevideoaimastery' }, IntersectionObserver: Intersection, MutationObserver: Mutation, ResizeObserver: undefined, requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id) })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const galleryModule = inGallery ? await import(`../src/gallery.js?gifTest=${++sequence}`) : null;
  const galleryCleanup = galleryModule?.initGalleries();
  const mod = await import(`../src/animated-media.js?test=${++sequence}`), mediaCleanup = mod.initAnimatedMedia();
  return { ...items[0], items, galleryToggle, track, frames, doc, motion, mod, intersections,
    get control() { return containers[0].querySelector('[data-motion-toggle]'); },
    cleanup() { mediaCleanup(); galleryCleanup?.(); },
    intersect(ratio, { rootMargin, item } = {}) {
      for (const observer of intersections) {
        if (rootMargin !== undefined && observer.options.rootMargin !== rootMargin) continue;
        const targets = [...observer.targets].filter(target => !item || target === item);
        observer.callback(targets.map(target => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio })));
      }
    },
  };
}
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

test('GIF loads only while visible and restores poster, responsive source, and aspect when hidden', async () => {
  const state = await setup();
  assert.equal(state.image.src, '/assets/animations/scene.jpg'); assert.equal(state.image.writes, 0);
  state.intersect(1);
  assert.equal(state.image.src, '/assets/animations/scene.gif'); assert.equal(state.image.getAttribute('srcset'), null);
  assert.equal(state.image.style.aspectRatio, '640 / 360');
  state.intersect(0);
  assert.equal(state.image.src, '/assets/animations/scene.jpg'); assert.match(state.image.getAttribute('srcset'), /2x/);
  state.intersect(1); state.doc.hidden = true; state.doc.emit('visibilitychange');
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.cleanup();
});

test('reduced motion defaults to poster and explicit pause persists across visibility changes', async () => {
  const state = await setup({ reduced: true });
  state.intersect(1); assert.equal(state.image.src, '/assets/animations/scene.jpg');
  assert.equal(state.toggle.textContent, 'Play animation');
  state.toggle.emit('click'); assert.equal(state.image.src, '/assets/animations/scene.gif');
  state.toggle.emit('click'); state.intersect(0); state.intersect(1);
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.motion.matches = false; state.motion.emit('change');
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.cleanup();
});

test('starting auto-scroll opts into GIF motion but stopping scroll preserves playback and individual pause', async () => {
  const state = await setup({ reduced: true, inGallery: true });
  state.intersect(1); assert.equal(state.toggle.disabled, false);
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.galleryToggle.emit('click');
  assert.equal(state.image.src, '/assets/animations/scene.gif'); assert.equal(state.toggle.disabled, false);
  const writes = state.image.writes;
  state.galleryToggle.emit('click');
  assert.equal(state.image.src, '/assets/animations/scene.gif'); assert.equal(state.image.writes, writes);
  state.toggle.emit('click');
  state.galleryToggle.emit('click'); state.galleryToggle.emit('click');
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.cleanup();
});

test('carousel pause and a manual swipe stop scrolling without restarting a visible GIF', async () => {
  const state = await setup({ inGallery: true });
  state.intersect(1); state.image.emit('load');
  assert.equal(state.image.dataset.animationState, 'playing');
  const writes = state.image.writes;
  state.galleryToggle.emit('click');
  assert.equal(state.frames.size, 0); assert.equal(state.galleryToggle.textContent, 'Auto-scroll');
  assert.equal(state.image.src, '/assets/animations/scene.gif'); assert.equal(state.image.writes, writes);
  state.galleryToggle.emit('click'); assert.equal(state.frames.size, 1);
  state.track.emit('touchstart');
  assert.equal(state.frames.size, 0); assert.equal(state.galleryToggle.getAttribute('aria-label'), 'Start automatic scrolling');
  assert.equal(state.image.dataset.animationState, 'playing'); assert.equal(state.image.writes, writes);
  state.toggle.emit('click'); assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.toggle.emit('click'); assert.equal(state.image.src, '/assets/animations/scene.gif');
  assert.equal(state.frames.size, 0);
  state.cleanup();
});

test('failed GIF requests fall back to poster without automatic retries or duplicate initialization', async () => {
  const state = await setup(); state.mod.initAnimatedMedia();
  state.intersect(1); assert.equal(state.image.writes, 1);
  state.image.emit('error'); assert.equal(state.image.src, '/assets/animations/scene.jpg');
  state.intersect(0); state.intersect(1); assert.equal(state.image.writes, 2);
  state.toggle.emit('click'); assert.equal(state.image.src, '/assets/animations/scene.gif');
  state.cleanup(); assert.equal(state.image.src, '/assets/animations/scene.jpg');
});

test('MP4 or non-image URLs are never loaded as the requested GIF animation', async () => {
  const state = await setup({ gif: '/assets/motion/scene.mp4' });
  state.intersect(1); state.toggle.emit('click');
  assert.equal(state.image.src, '/assets/animations/scene.jpg'); assert.equal(state.toggle.disabled, true);
  state.cleanup();
});

test('many loop clips share observers and request only near posters and visible video sources', async () => {
  const state = await setup({ kind: 'video', count: 30 });
  assert.equal(state.intersections.length, 2);
  for (const { image } of state.items) {
    assert.equal(image.src, null); assert.equal(image.poster, null); assert.equal(image.preload, 'none');
    assert.equal(image.playCalls, 0); assert.equal(image.loadCalls, 0);
    assert.equal(image.style.aspectRatio, '640 / 360');
  }
  const first = state.items[0].image;
  state.intersect(1, { rootMargin: '200px', item: first });
  assert.equal(first.poster, '/assets/animations/scene.jpg'); assert.equal(first.src, null);
  state.intersect(0.05, { rootMargin: '0px', item: first });
  assert.equal(first.src, null);
  state.intersect(0.2, { rootMargin: '0px', item: first }); await settled();
  assert.equal(first.src, '/assets/animations/scene.mp4'); assert.equal(first.dataset.animationState, 'playing');
  assert.equal(first.muted, true); assert.equal(first.defaultMuted, true); assert.equal(first.loop, true); assert.equal(first.playsInline, true);
  assert.ok(state.items.slice(1).every(({ image }) => image.src === null && image.poster === null));
  state.cleanup();
  assert.ok(state.intersections.every(observer => observer.targets.size === 0));
});

test('loop playback survives carousel pause and swipe, but stops offscreen or when the page hides', async () => {
  const state = await setup({ kind: 'video', inGallery: true });
  state.intersect(1); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.image.playCalls, 1);
  state.galleryToggle.emit('click'); state.track.emit('touchstart'); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.image.playCalls, 1);
  assert.equal(state.frames.size, 0);
  state.intersect(0, { rootMargin: '0px' });
  assert.equal(state.image.paused, true);
  state.intersect(1, { rootMargin: '0px' }); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.image.writes, 1);
  state.doc.hidden = true; state.doc.emit('visibilitychange'); assert.equal(state.image.paused, true);
  state.doc.hidden = false; state.doc.emit('visibilitychange'); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.image.writes, 1);
  state.cleanup();
});

test('reduced motion loads only the poster, exposes opt-in, and keeps an explicit animation pause', async () => {
  const state = await setup({ kind: 'video', reduced: true, inGallery: true, withToggle: false });
  state.intersect(1); await settled();
  assert.equal(state.image.poster, '/assets/animations/scene.jpg'); assert.equal(state.image.src, null);
  assert.equal(state.control.hidden, false); assert.equal(state.control.textContent, 'Play animation');
  state.control.emit('click'); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.control.hidden, true);
  state.motion.matches = false; state.motion.emit('change');
  state.control.emit('click');
  state.galleryToggle.emit('click'); state.galleryToggle.emit('click');
  state.intersect(0); state.intersect(1); await settled();
  assert.equal(state.image.paused, true); assert.equal(state.control.hidden, false);
  state.cleanup();
});

test('blocked autoplay restores the poster and a working retry button without repeated automatic requests', async () => {
  const state = await setup({ kind: 'video', withToggle: false, playBehavior: () => Promise.reject(new Error('NotAllowedError')) });
  state.intersect(1); await settled();
  assert.equal(state.image.src, null); assert.equal(state.image.poster, '/assets/animations/scene.jpg');
  assert.equal(state.image.paused, true); assert.equal(state.control.hidden, false);
  assert.equal(state.control.disabled, false); assert.equal(state.control.textContent, 'Play animation');
  state.intersect(0); state.intersect(1); await settled();
  assert.equal(state.image.playCalls, 1);
  state.image.playBehavior = () => Promise.resolve(); state.control.emit('click'); await settled();
  assert.equal(state.image.playCalls, 2); assert.equal(state.image.paused, false);
  assert.equal(state.image.dataset.animationState, 'playing'); assert.equal(state.control.hidden, true);
  state.cleanup();
});

test('starting carousel scrolling retries a blocked loop without overriding individual pause', async () => {
  const state = await setup({ kind: 'video', inGallery: true, playBehavior: () => Promise.reject(new Error('blocked')) });
  state.intersect(1); await settled();
  state.galleryToggle.emit('click'); // Stop the initially running scroll.
  state.image.playBehavior = () => Promise.resolve();
  state.galleryToggle.emit('click'); await settled();
  assert.equal(state.image.paused, false); assert.equal(state.image.playCalls, 2);
  state.toggle.emit('click');
  state.galleryToggle.emit('click'); state.galleryToggle.emit('click'); await settled();
  assert.equal(state.image.paused, true); assert.equal(state.image.playCalls, 2);
  state.cleanup();
});

test('late play completion cannot restart an offscreen or explicitly paused clip', async () => {
  let finish;
  const state = await setup({ kind: 'video', playBehavior: () => new Promise(resolve => { finish = resolve; }) });
  state.intersect(1);
  assert.equal(state.image.playCalls, 1);
  state.intersect(0); state.image.paused = false; finish(); await settled();
  assert.equal(state.image.paused, true); assert.notEqual(state.image.dataset.animationState, 'playing');
  state.intersect(1); state.toggle.emit('click'); state.image.paused = false; finish(); await settled();
  assert.equal(state.image.paused, true); assert.equal(state.toggle.textContent, 'Play animation');
  state.cleanup();
});

test('a pending cancelled play can recover when the clip reenters before settlement', async () => {
  let reject;
  const state = await setup({ kind: 'video', playBehavior: () => new Promise((resolve, fail) => { reject = fail; }) });
  state.intersect(1); state.intersect(0); state.intersect(1);
  state.image.playBehavior = () => Promise.resolve(); reject(new Error('AbortError')); await settled();
  assert.equal(state.image.playCalls, 2); assert.equal(state.image.paused, false);
  assert.equal(state.image.dataset.animationState, 'playing'); assert.equal(state.toggle.textContent, 'Pause animation');
  state.cleanup();
});

test('media errors reset to poster and cleanup prevents pending playback or duplicate initialization', async () => {
  const state = await setup({ kind: 'video' });
  state.mod.initAnimatedMedia(); assert.equal(state.intersections.length, 2);
  state.intersect(1); await settled(); state.image.emit('error');
  assert.equal(state.image.src, null); assert.equal(state.image.poster, '/assets/animations/scene.jpg');
  state.intersect(1); await settled(); assert.equal(state.image.playCalls, 1);
  let finish;
  state.image.playBehavior = () => new Promise(resolve => { finish = resolve; });
  state.toggle.emit('click'); assert.equal(state.image.playCalls, 2);
  state.cleanup(); state.image.paused = false; finish(); await settled();
  assert.equal(state.image.paused, true); assert.equal(state.image.src, null);
  state.doc.emit('visibilitychange'); assert.equal(state.image.playCalls, 2);
});
