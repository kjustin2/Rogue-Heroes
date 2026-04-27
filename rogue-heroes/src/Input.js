export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouse = {
      x: 0,
      y: 0,
      down: false,
      justClicked: false,
      rightClicked: false,
    };

    window.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      this.keys.add(key);
      this.justPressed.add(key);
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
      }
    });

    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.key.toLowerCase());
    });

    window.addEventListener("mousemove", (event) => this.updateMouse(event));
    canvas.addEventListener("mousedown", (event) => {
      this.updateMouse(event);
      if (event.button === 0) {
        this.mouse.down = true;
        this.mouse.justClicked = true;
      }
      if (event.button === 2) this.mouse.rightClicked = true;
    });
    window.addEventListener("mouseup", () => {
      this.mouse.down = false;
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  updateMouse(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    this.mouse.x = (event.clientX - rect.left) * scaleX;
    this.mouse.y = (event.clientY - rect.top) * scaleY;
  }

  pressed(key) {
    return this.justPressed.has(key.toLowerCase());
  }

  endFrame() {
    this.justPressed.clear();
    this.mouse.justClicked = false;
    this.mouse.rightClicked = false;
  }
}
