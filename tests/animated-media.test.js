import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const globals = ['window', 'document', 'location', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let sequence = 0;
afterEach(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

async function setup({ reduced = false, inGallery = false, gif = '/assets/animations/scene.gif' } = {}) {
  const intersections = [], mutations = [];
  class Element {
    constructor() { this.handlers = new Map(); this.attributes = new Map(); this.style = {}; this.dataset = {}; this.writes = 0; this.children = []; this.textContent = ''; }
    addEventListener(name, callback) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(callback); }
    emit(name) { for (const callback of this.handlers.get(name) || []) callback(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    contains(element) { return element === this || this.children.includes(element); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); for (const observer of mutations) if (observer.target === this) observer.callback(); }
    removeAttribute(name) { this.attributes.delete(name); }
    get src() { return this.getAttribute('src'); }
    set src(value) { this.writes++; this.setAttribute('src', value); }
  }
  const container = new Element(), image = new Element(), toggle = new Element(), galleryToggle = new Element();
  const gallery = new Element(), track = new Element();
  track.clientWidth = 400; track.scrollWidth = 1000; track.scrollLeft = 0; track.children = [image];
  track.querySelectorAll = () => [];
  gallery.querySelector = selector => ({ '.gallery-track': track, '[data-gallery-toggle]': galleryToggle })[selector];
  image.setAttribute('src', '/assets/animations/scene.jpg'); image.setAttribute('width', '640'); image.setAttribute('height', '360');
  image.setAttribute('srcset', '/assets/animations/scene@2x.jpg 2x'); image.dataset.gifSrc = gif;
  container.querySelectorAll = () => [image]; container.querySelector = () => toggle;
  container.closest = () => inGallery ? gallery : null;
  galleryToggle.setAttribute('aria-pressed', String(reduced));
  const doc = new Element(); doc.hidden = false;
  doc.querySelectorAll = selector => selector === '[data-gallery]' ? (inGallery ? [gallery] : []) : [container];
  const motion = new Element(); motion.matches = reduced;
  const win = new Element(); win.matchMedia = () => motion;
  class Intersection { constructor(callback) { this.callback = callback; this.targets = new Set(); intersections.push(this); } observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); } }
  class Mutation { constructor(callback) { this.callback = callback; mutations.push(this); } observe(target) { this.target = target; } disconnect() { this.target = null; } }
  const frames = new Map(); let nextFrame = 0;
  for (const [name, value] of Object.entries({ window: win, document: doc, location: { href: 'https://formumaxlabs.com/ultimatevideoaimastery' }, IntersectionObserver: Intersection, MutationObserver: Mutation, ResizeObserver: undefined, requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id) })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const galleryModule = inGallery ? await import(`../src/gallery.js?gifTest=${++sequence}`) : null;
  const galleryCleanup = galleryModule?.initGalleries();
  const mod = await import(`../src/animated-media.js?test=${++sequence}`), mediaCleanup = mod.initAnimatedMedia();
  return { image, toggle, galleryToggle, track, frames, doc, motion, mod,
    cleanup() { mediaCleanup(); galleryCleanup?.(); },
    intersect(ratio) { for (const observer of intersections) observer.callback([...observer.targets].map(target => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio }))); },
  };
}

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
