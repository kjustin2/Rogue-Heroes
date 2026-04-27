export class Engine {
  constructor(update, render, getState) {
    this.update = update;
    this.render = render;
    this.getState = getState || (() => "build");
    this.running = false;
    this.last = performance.now();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((time) => this.loop(time));
  }

  loop(time) {
    if (!this.running) return;
    requestAnimationFrame((next) => this.loop(next));
    const dt = Math.min(0.05, (time - this.last) / 1000);
    this.last = time;
    this.update(dt);
    this.render();
  }
}
