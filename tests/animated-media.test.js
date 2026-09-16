import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const globals = ['window', 'document', 'location', 'IntersectionObserver', 'MutationObserver'];
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let sequence = 0;
afterEach(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

async function setup({ reduced = false, inGallery = false, gif = '/assets/animations/scene.gif' } = {}) {
  const intersections = [], mutations = [];
  class Element {
    constructor() { this.handlers = new Map(); this.attributes = new Map(); this.style = {}; this.dataset = {}; this.writes = 0; }
    addEventListener(name, callback) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(callback); }
    emit(name) { for (const callback of this.handlers.get(name) || []) callback(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); for (const observer of mutations) if (observer.target === this) observer.callback(); }
    removeAttribute(name) { this.attributes.delete(name); }
    get src() { return this.getAttribute('src'); }
    set src(value) { this.writes++; this.setAttribute('src', value); }
  }
  const container = new Element(), image = new Element(), toggle = new Element(), galleryToggle = new Element();
  image.setAttribute('src', '/assets/animations/scene.jpg'); image.setAttribute('width', '640'); image.setAttribute('height', '360');
  image.setAttribute('srcset', '/assets/animations/scene@2x.jpg 2x'); image.dataset.gifSrc = gif;
  container.querySelectorAll = () => [image]; container.querySelector = () => toggle;
  container.closest = () => inGallery ? { querySelector: () => galleryToggle } : null;
  galleryToggle.setAttribute('aria-pressed', String(reduced));
  const doc = new Element(); doc.hidden = false; doc.querySelectorAll = () => [container];
  const motion = new Element(); motion.matches = reduced;
  const win = new Element(); win.matchMedia = () => motion;
  class Intersection { constructor(callback) { this.callback = callback; intersections.push(this); } observe(target) { this.target = target; } disconnect() {} }
  class Mutation { constructor(callback) { this.callback = callback; mutations.push(this); } observe(target) { this.target = target; } disconnect() { this.target = null; } }
  for (const [name, value] of Object.entries({ window: win, document: doc, location: { href: 'https://formumaxlabs.com/ultimatevideoaimastery' }, IntersectionObserver: Intersection, MutationObserver: Mutation })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const mod = await import(`../src/animated-media.js?test=${++sequence}`), cleanup = mod.initAnimatedMedia();
  return { image, toggle, galleryToggle, doc, motion, mod, cleanup, intersect(ratio) { for (const observer of intersections) observer.callback([{ target: image, isIntersecting: ratio > 0, intersectionRatio: ratio }]); } };
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

test('gallery Play overrides reduced-motion default and gallery Pause restores GIF posters', async () => {
  const state = await setup({ reduced: true, inGallery: true });
  state.intersect(1); assert.equal(state.toggle.disabled, true);
  state.galleryToggle.setAttribute('aria-pressed', 'false');
  assert.equal(state.image.src, '/assets/animations/scene.gif'); assert.equal(state.toggle.disabled, false);
  state.galleryToggle.setAttribute('aria-pressed', 'true');
  assert.equal(state.image.src, '/assets/animations/scene.jpg');
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
