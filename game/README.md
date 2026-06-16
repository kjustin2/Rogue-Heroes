# Rogue Heroes Tactics

Fresh 3D prototype for the new Rogue Heroes direction: a turn-based RTS battle
loop with blocky units, destructible environments, and component-level damage.

## Run

```powershell
npm install
npm run dev
```

Open `http://localhost:5175`.

## Standalone Electron

```powershell
npm install
npm run standalone
```

Use `npm run desktop` to launch Electron against an already-built `dist/`
folder.

## Verify

```powershell
npm run verify
npm run smoke:browser
```

The foundation mirrors the useful Rogue-Hero-3 habits:

- Vite + TypeScript + Three.js for fast iteration.
- Pure, testable game rules for the damage model.
- Deterministic scenario setup and an automation hook at `window.__rht`.
- Browser smoke tests that capture screenshots into `shots/`.

## Current Slice

- Command phase: select a unit, queue move, shoot, or ram orders.
- Resolve phase: queued orders play out in a short real-time burst, then the next
  command phase begins.
- Tanks have hull, cannon, turret, and tread parts. Destroying a tread stops
  movement. Destroying the cannon stops shooting. Destroying the turret ring
  jams the tank even if the cannon is still attached. Stripping front armor
  exposes the hull to heavier follow-up damage.
- Soldiers have body, head, and rifle parts. Destroying the rifle disarms them.
  Destroying the head kills instantly. Destroying the power pack limits command
  points and shocks nearby friendly orders.
- Bases have core, turret, comms, and power parts. Individual parts can be shot
  off before the base is destroyed. Comms loss degrades enemy command capacity,
  turret loss disarms the base, and the power cell detonates.
- Cover and fuel cells block lines of fire and can be destroyed.
- Destroyed parts throw persistent chunks onto the battlefield so the damage
  state remains readable after the hit.
