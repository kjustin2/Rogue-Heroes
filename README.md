# Rogue Heroes Tactics

Clean-slate 3D prototype for the next Rogue Heroes direction.

The active game lives in [`game/`](game/). It is a Vite + TypeScript + Three.js
app with an Electron wrapper, unit tests, and browser smoke automation.

## Run

```powershell
cd game
npm install
npm run dev
```

Open `http://127.0.0.1:5175/`.

## Standalone Electron

```powershell
cd game
npm install
npm run standalone
```

Use `npm run desktop` from `game/` to launch Electron against an already-built
`dist/` folder.

## Verify

```powershell
cd game
npm run verify
npm run smoke:browser
npm run smoke:flow
npm run smoke:electron
```

Use `npm run test:full` to run the full local gate in one command after dependencies are installed.
