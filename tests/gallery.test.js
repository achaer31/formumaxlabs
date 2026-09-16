import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const names = ['window', 'document', 'IntersectionObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let sequence = 0;
afterEach(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

async function setup({ reduced = false, videoCount = 2 } = {}) {
  class Element {
    constructor() { this.handlers = new Map(); this.attributes = new Map(); this.style = {}; this.children = []; this.textContent = ''; this.dataset = {}; }
    addEventListener(name, callback) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(callback); }
    emit(name, data = {}) { for (const callback of this.handlers.get(name) || []) callback(data); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    contains(element) { return element === this || this.children.includes(element); }
  }
  class Video extends Element {
    constructor(index) { super(); this.dataset.src = `/assets/motion/${index}.mp4`; this.paused = true; this.plays = 0; this.loads = 0; }
    load() { this.loads++; }
    play() { this.plays++; this.paused = false; this.emit('play'); return Promise.resolve(); }
    pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  }
  const gallery = new Element(), track = new Element(), previous = new Element(), next = new Element(), toggle = new Element();
  const videos = Array.from({ length: videoCount }, (_, index) => new Video(index));
  track.clientWidth = 400; track.scrollWidth = 1000; track.scrollLeft = 0; track.children = videos;
  track.querySelectorAll = () => videos;
  track.scrollBy = ({ left }) => { track.scrollLeft = Math.max(0, Math.min(600, track.scrollLeft + left)); track.emit('scroll'); };
  gallery.children = [track, previous, next, toggle];
  gallery.querySelector = selector => ({ '.gallery-track': track, '[data-gallery-prev]': previous, '[data-gallery-next]': next, '[data-gallery-toggle]': toggle })[selector];
  const doc = new Element(); doc.hidden = false; doc.activeElement = null; doc.querySelectorAll = () => [gallery];
  const motion = new Element(); motion.matches = reduced;
  const win = new Element(); win.matchMedia = () => motion;
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  }
  const frames = new Map(); let nextFrame = 0, time = 0;
  const values = { window: win, document: doc, IntersectionObserver: Observer, ResizeObserver: undefined, requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id) };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const mod = await import(`../src/gallery.js?test=${++sequence}`);
  const cleanup = mod.initGalleries();
  return {
    mod, cleanup, gallery, track, previous, next, toggle, videos, doc, motion, frames,
    intersect(target, ratio) { for (const observer of observers) if (observer.targets.has(target)) observer.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]); },
    advance(milliseconds) { time += milliseconds; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time); },
  };
}

test('gallery loads only visible videos and pauses media and scrolling when the page hides', async () => {
  const state = await setup();
  assert.equal(state.videos[0].src, undefined);
  state.intersect(state.track, 1); state.intersect(state.videos[0], 1);
  assert.equal(state.videos[0].loads, 1);
  assert.equal(state.videos[0].plays, 1);
  assert.equal(state.videos[1].loads, 0);
  assert.equal(state.videos[0].muted, true);
  assert.equal(state.videos[0].loop, true);
  assert.equal(state.videos[0].playsInline, true);
  state.doc.hidden = true; state.doc.emit('visibilitychange');
  assert.equal(state.videos[0].paused, true);
  assert.equal(state.frames.size, 0);
  state.cleanup();
});

test('static image galleries pingpong at30px/s without cloning and pause after manual navigation', async () => {
  const state = await setup({ videoCount: 0 });
  state.intersect(state.track, 1); state.advance(0); state.advance(100);
  assert.equal(state.track.scrollLeft, 3);
  state.gallery.emit('pointerenter', { pointerType: 'mouse' });
  state.track.scrollLeft = 599;
  state.gallery.emit('pointerleave'); state.advance(0); state.advance(100); assert.equal(state.track.scrollLeft, 600);
  state.advance(100); assert.equal(state.track.scrollLeft, 597);
  state.track.emit('pointerdown', { pointerType: 'touch' });
  assert.equal(state.frames.size, 0); assert.equal(state.toggle.textContent, 'Play gallery');
  state.toggle.emit('click'); assert.ok(state.frames.size > 0);
  assert.equal(state.track.children.length, 0);
  state.cleanup();
});

test('reduced motion defaults paused and an explicit user pause survives preference changes', async () => {
  const state = await setup({ reduced: true });
  state.intersect(state.track, 1); state.intersect(state.videos[0], 1);
  assert.equal(state.frames.size, 0); assert.equal(state.videos[0].loads, 0);
  assert.equal(state.toggle.textContent, 'Play gallery');
  state.toggle.emit('click'); assert.equal(state.videos[0].plays, 1);
  state.toggle.emit('click');
  state.motion.matches = true; state.motion.emit('change');
  state.motion.matches = false; state.motion.emit('change');
  assert.equal(state.toggle.textContent, 'Play gallery'); assert.equal(state.frames.size, 0);
  assert.equal(state.videos[0].paused, true);
  state.cleanup();
});

test('individual video pause persists when cards leave and reenter the viewport', async () => {
  const state = await setup();
  state.intersect(state.track, 1); state.intersect(state.videos[0], 1);
  await Promise.resolve(); await Promise.resolve();
  state.videos[0].pause();
  state.intersect(state.videos[0], 0); state.intersect(state.videos[0], 1);
  assert.equal(state.videos[0].plays, 1); assert.equal(state.videos[0].paused, true);
  assert.equal(state.videos[0].loads, 1);
  state.cleanup();
});

test('initializing the same gallery twice keeps one animation and cleanup prevents further playback', async () => {
  const state = await setup(); state.mod.initGalleries();
  state.intersect(state.track, 1); state.intersect(state.videos[0], 1);
  assert.equal(state.frames.size, 1); assert.equal(state.videos[0].loads, 1);
  state.cleanup(); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.frames.size, 0); assert.equal(state.videos[0].paused, true);
});

test('fractional motion accumulates when a browser rounds native scroll positions', async () => {
  const state = await setup({ videoCount: 0 });
  let rounded = 0;
  Object.defineProperty(state.track, 'scrollLeft', { get: () => rounded, set: value => { rounded = Math.round(value); } });
  state.intersect(state.track, 1); state.advance(0);
  for (let index = 0; index < 60; index++) state.advance(1000 / 60);
  assert.equal(state.track.scrollLeft, 30);
  state.cleanup();
});

test('explicit Play overrides current control focus and hover until the next interaction', async () => {
  const state = await setup({ videoCount: 0 });
  state.intersect(state.track, 1);
  state.gallery.emit('focusin'); state.gallery.emit('pointerenter', { pointerType: 'mouse' });
  state.toggle.emit('click'); // Pause explicitly before requesting Play.
  state.toggle.emit('click');
  state.advance(0); state.advance(100);
  assert.equal(state.track.scrollLeft, 3);
  state.gallery.emit('focusin'); // Navigating to another focus target pauses again.
  assert.equal(state.frames.size, 0);
  state.toggle.emit('click'); state.toggle.emit('click');
  assert.ok(state.frames.size > 0);
  state.gallery.emit('pointerleave'); state.gallery.emit('pointerenter', { pointerType: 'mouse' });
  assert.equal(state.frames.size, 0);
  state.cleanup();
});
