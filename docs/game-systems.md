# Game systems: factions, AI, hotseat

How the factions, the three AI brains and Local 2 Players work, with the measurements behind each.

## Roster cut (2026-10-04, owner: "3-4 too many units per faction")
Cut from every roster and from the code: **Medic/Corpsman, Engineer/Mechanic, Pad Tech (springer), Interceptor, Oil Rigger, Sapper (Scattergun), APC**,
the Bastion **Demolisher** (demo stays Syndicate's Blaster), the **Flak Nest** defense, and everything that only they used: the `treat` order
(Heal/Repair), stims/overcharge, support auras, DOWNED troopers and revives, bounce pads, oil slicks, the sapper's mines order and wall breach
(mines now come from the Minefield defense and the Minefield Drop strike), the Triage / Welding / Field Hospital techs (`healBonus` and
`repairBonus` are gone). The **Medevac** strike is the only heal and now sits on Support Wing; Field Works needs only Assault.
Final rosters (14 / 14 / 13): **Vanguard** soldier, scout, sniper, jumper, heavy, bazooka, lancer, turrettech, tank, hornet, runabout, flak, gunship,
transport. **Syndicate** soldier, sniper, heavy, striker, grenadier, flamer, demo, bazooka, sledge, bounty, turrettech, droneop, runabout, flak.
**Bastion** soldier, sniper, heavy, mortar, builder, ironclad, trencher, turrettech, tank, artillery, runabout, flak, bomber. The **Flak Track** is
the one anti-air unit every faction keeps. Any older section below that names a removed unit or system is superseded by this one.

## FACTIONS play, look and fight differently (2026-09-22)

- **THE FACTION READ IS MEASURED** (2026-09-24, owner: "infantry all look the same across factions and bases
  don't look different enough"): `npm run measure:factions` stages the HQ + rifleman / heavy / marksman / medic
  alone per faction on the real GPU (`shots:gpu factionmeasure`), then scores every faction PAIR: silhouette IoU
  (infantry <= 0.80, HQ <= 0.70) and saturation-weighted hue distance (>= 40 degrees). Baseline 0/15 pairs -> 15/15.
  `MEASURE_GATE=1` fails the run below the goal. What got it there, all in `worldRenderer.ts`:
  `factionInfantryDress` is a SILHOUETTE kit per faction on existing part ids (Vanguard crest fin + lit visor
  band + jet pack with swept fins + shoulder sensor pod + whip antenna; Syndicate pointed hood + face scarf +
  ankle-length duster; Bastion bucket helm + huge pauldrons + tassets + tower shield), `factionBaseDress` is
  architecture (Vanguard control tower + radar + helipad; Syndicate scrap palisade + crane; Bastion hex ring
  wall + glacis + dome + pillboxes), and `FACTION_CAMO` is three hue families (steel blue / rust / green) blended
  0.62 into troopers, 0.6 into machines.
  Silhouette mode hides contact shadows (they were a black disc in every shape test, `shots:silhouette` too).
  The heavy's Vanguard/Syndicate pair sits AT 0.80 -- the one to watch. Same-faction mirror matches still read
  by team (ring, trim, glow): `shots:gpu -- sameside`.
  **Extended to every unit (2026-09-24)**: the measure also compares the shared MACHINES (tank, flak, turret;
  turret held to the HQ's 0.70) and checks MEMBERSHIP -- every unit a faction fields is shot alone and must sit
  nearest its own faction's signature hue (mean of HQ + rifleman) by >= 15 degrees. `factionMachineDress` gives
  the Flak Track and Gun Turret a per-faction outline (Vanguard radome / sensor dome; Syndicate scrap-shield
  "technical" + pennant; Bastion casemate / hex pillbox) and the flyers a faction livery (fuselage band, wing
  panels, engine burn in the faction light -- the old shared orange burn made every jet read Syndicate; bombs
  are drab with a hazard band). Medics wear a NEUTRAL vest (faction camo carries it) with a smaller cross.
  Flyers are captured at agl 1.6 so the plane, not its shadow, is measured.
- **Infantry wear the ink rim** (`INFANTRY_INK` 1.6cm) on big silhouette parts only (longest side >= 0.3m,
  thinnest >= 0.08m, never the knee-split legs). **Faction stance** (`FACTION_STANCE`: torso lean, head
  counters) and **per-part hit reactions** (`partHitByEntity`: head snaps back, thigh buckles, pack spins,
  weapon knocked aside, chest rocks -- on the hit part even if the hit destroyed it) live in `paintPart`, torso
  and head only, so the distance-locked gait is untouched (`smoke:animation` skate unchanged). Evidence:
  `shots:gpu -- hitreactprobe` prints the swing (0.53 rad after a leg strike vs 0.06 idle). The perf baseline
  was rebased for this (+35% draw calls on the stress scene; real-GPU p95 ~21ms, unchanged).
- **Identity pass (2026-09-23, owner: "still too similar in look and gameplay")**. Rosters share
  only a CORE (rifleman, heavy gunner, marksman, medic, flak; tank on two) and each faction OWNS a
  block (`signatureUnits(id)`, derived): Vanguard = scout, jumper, gunship, interceptor, transport;
  Syndicate = striker, grenadier, flamer, sapper, drone op, APC; Bastion = mortar, engineer,
  artillery, bomber (+ Mortar Turret). The heavy gunner is core because the AI leans on it: any
  faction without it lost AI-vs-AI games outright (`npm run balance:factions`). THREE support powers each, never shared, starter first (owner 2026-10-01: "should start out with some starter thing and have more options in them based on your tech line ... differ per faction"): Vanguard Recon Sweep (start) / Airstrike (Support Wing) / Paradrop (Air Wing: two Troopers land at the point, field cap respected); Syndicate Smoke Screen (start) / Napalm (Assault: three firebombs, 2-turn burning ground) / Cluster Strike (Ordnance); Bastion Resupply Drop (start) / Orbital Lance (Armor Bay) / Barrage (Siege Works: six heavy shells walk a 4.5m circle). DEFENSES deck, 5-6 each: starters everyone has (Sandbags $60 = neutral low cover; Blast Wall $130), shared tech pieces (Gun Turret, Assault; Flak Nest $230, Armor Bay: the Flak Track's gun on a mount) and the faction's own: Vanguard Sensor Mast (Recon: a 10m spotter relay, no gun), Syndicate Minefield (Ordnance: three mines in a turnable triangle), Bastion Mortar Turret (Ordnance) + MG Bunker (Armor Bay: a Heavy Gunner's suppressing burst behind 150 HP of concrete). `doctrines.test.ts` pins starters / tech gates / one-of-its-own; `sim.test.ts` asserts every deck entry, on every map and faction, either REFUSES TO ARM (locked) or arms AND has a legal spot in its ring (the owner's locked-turret bug, fault-injection proven). The bot drops its strongest affordable DAMAGING power on a crowd (`DAMAGING_SUPPORT`, read top tier first); it does not build defenses or use the utility powers (not yet asked). The flat
  stat passives were replaced by a `doctrine` rule, each read by one clause in sim.ts:
  **Rapid Response** (Vanguard: `troopCooldownFor`/`supportCooldownFor` a turn shorter, min 1;
  deploy ring +4m), **Scavengers** (Syndicate: `recordDamage` pays 30% of a destroyed enemy troop's
  cost; it also keeps the old +15% splash `passive`), **Dig In** (Bastion: in `endTurn` a ground
  troop with no `MOVING_ORDERS` order is `digging` for that resolve and `dugIn = 0.8` from the next
  one it holds -- same-turn dig-in won Bastion 33 of 52 AI games; tanks excepted, they have
  hull-down; `applyDamage` scales ALL damage by it and the shot preview shows it; a knockback throw
  or boarding clears both; renderer shows a sandbag arc, HUD says "Digging in" / "Dug in").
  Shared units carry faction NAMES via `labels` / `sim.troopLabel(team, kind)` (Recruit = Trooper /
  Raider / Guardsman) -- use it, not `troopSpec(kind).label`, anywhere a player sees a unit name.
  Normal/Hard bots call their strike (`enemyStrikeAct`: 3+ weight of hostiles within 3m, no own unit
  within 6.5m). Tests: `doctrines.test.ts`. Look: faction HELMET colour (`FACTION_HELMET`, 0.55
  over the kind's), infantry camo 0.42, Syndicate hood, Bastion gorget + hazard chevrons, Vanguard
  tank smoke launchers + deck chevron, Syndicate ram plough, Bastion dozer blade. Evidence:
  `npm run shots:factions` (SwiftShader-safe sheet: shared units + signature units + a vehicle).
- **The bot plays its faction**: `aiTechPath` is its signature research arc (Vanguard armour →
  air wing, Syndicate ordnance → armour for the APC, Bastion armour → siege). With two or more units out it
  SAVES for the next doctrine and for its most-wanted unlocked unit. Before this it never
  researched past the free doctrine — a Vanguard bot fielded ten Recruits — so every faction played
  the same against the AI. Measured by `npm run balance:factions` (AI-vs-AI, 6 maps × 4 seeds
  × both seats per pairing, 2026-09-23): Vanguard 32 / Syndicate 30 / Bastion 25 wins, 57 draws.
  Not a gate; rerun it if you touch a roster, a doctrine or the AI economy. Known: the bots still
  field mostly riflemen and heavy gunners, so signature units show up more in a player's army.
- **Artillery and the mortar battery LOB** (`projectileArcHeight(..., source)`): they inherited the
  tank's 0.28 arc and fired flat. `projectiles.test.ts` asserts every family's flight (flat vs lobbed,
  never stalls, passes near its target, gone after the resolve) and gunship behaviour end to end.
- Set-up page: "Your faction" and "Enemy faction" (with Random, rolled in the app, not the sim) are
  equal card rows; in Local 2 Players the second row is Player 2. Modes offered: `PLAYABLE_MODES` —
  Annihilation, Capture the Flag, Hold the Hill (Domination and Last Stand stay in the sim, unoffered).
- **Tech is cheap and says what it is** (2026-09-24), **rebuilt 2026-10-03** so no branch is a dead end and the
  armour road is not the only road. Doctrines $100 (Recon, Assault) / $150-200 (Support, Ordnance, Armor) / $240-260
  (Siege, Air Wing); specializations $130-160. Each research card carries a tag — cyan **NEW UNITS** (a doctrine:
  lists every unit, defense and support power it opens for this faction) or amber **UPGRADE** (a
  specialization, pick one of each pair).
  - **Every threat has an answer outside the road that makes it**: Recon owns the Flak Track, Flak Nest, Scout,
    Marksman and Drone Op (air answer + eyes); Assault owns the Rocketeer, Striker, Heavy, Jump Trooper (armour answer
    + pressure); Armor Bay is tanks/APC/bunker/Lance only.
  - **Aircraft and artillery are the deep end**: Siege Works and Air Wing need Armor Bay AND Recon (radar / spotters),
    so the plane rush costs ~$700 of tech before the first gunship. `tech.test.ts` pins that ordering.
  - **Upgrades must beat buying another unit**: researching spends the base order (a deploy forgone) plus $130-160, so
    each pays a team-wide +25% (infantry damage, infantry HP, vehicle HP), +30% vs vehicles, +40% splash / +50% radius,
    double aura heal/repair, a sharper spotter, or +40% scatter on shots at you.
  - The bot's `aiTechPath` now includes Recon where it needs it and ends in one upgrade.
- Locked troops in the Deploy tab are NAMED, grouped by the doctrine that unlocks them ("Scout ·
  Marksman / 🔒 Recon Doctrine") — never a "▮▮▮ ×2" count.

## OWNER BATCH 2026-10-02 (rules that came out of it)

- **Air.** A gunship's BOMB is a bomb RUN: pick ground or a foe, it flies over (a move, so 2 AP) and drops straight
  down; 4.4m blast, 96 dmg, throws troops up to 9m. The Bomber's carpet is 3.4m x3. The gunship's autocannon hits
  ground AND air; the interceptor's only air. Nothing fires unasked (the auto strafe is gone). Expensive units hit
  harder: artillery 3.0m/62, mortar turret 2.6m/50 (`explosiveBlast` in sim.ts). Tank $680, Striker $440 (balance band).
- **High ground.** Spread x0.7 from a 0.45m rise, x0.5 from a mesa step (1.2m+); shooting UP x1.6 / x2.2. Aircraft fire down.
- **Mid-air collisions.** Opposed rounds closer than 0.42m in 3D meet: plain rounds cancel; a hit grenade/shell goes
  off there. Aircraft bombs are exempt. (Staged smokes must stop the target firing back.)
- **Base systems.** Comms Mast dead: every unit refills 1 AP (both sides). Blast Gate dead: deploy ring shrinks to
  beside the base, reinforcement cooldown +1. Reactor: income by health. The base panel shows chips for each.
- **Bots.** Ground units plan an A* route (1.2m grid, wall clearance = `spawnClearance`) instead of the greedy
  sidestep; no two end a move on top of each other (`spreadDestination`); Hard seeks high ground and builds a gun
  emplacement toward closing foes (`enemyDefenseAct`).
- **Bot economy (2026-10-02 AI pass).** Measured with a Hard-vs-Normal self-play harness (36 games, surviving-HP
  share): the old Hard bot researched every turn (the base has ONE order a turn) and sat on $800 with two troops
  (share 0.485 = worse than Normal). `smartEconomyAct` (Normal + Hard): parity first (>= 3 troops and the foe's
  count), the AP upgrade (two base orders; the bot now spends every base order), early income, the next doctrine
  on its path only with 4+ troops out, else the most-wanted troop. Share -> 0.58 vs the old Normal; Hard's tactics
  on top (stand-off at ~0.55 range instead of 6m) add ~0.04. Tried and REMOVED (no gain or negative): army
  cohesion (-0.02), weak-target pressing (-0.01), wounded-retreat threshold, threat-weighted A* (+0.005).
  Hard also runs gunship/bomber BOMB RUNS on clusters (2 AP) and sends the crippled to a medic.
- **Achievements** are four pages (Battles / Kills / Skill / Range), 46 medals with higher tiers; `commander.test.ts`
  asserts a long perfect career earns every one.

## FIELD HANDS, MOUNTED GUNS, HEIGHT, AUDIO (owner batch 2026-10-03)

- **Height is continuous** (`accuracyForShot`): shooter above the target by `d` metres scales the spread by
  `1/(1+1.1*(d-0.3))` (floor 0.2): 1.2m = half, 3m = a fifth. Below: `1+1.3*(|d|-0.3)` (cap 4): 1.2m = 2x,
  3m = 3.7x. Aircraft shoot down at no penalty. No tiers.
- **[REMOVED 2026-10-04 with the Medic and Engineer] Heal / Repair** (order `treat`, `sim.queueTreat`): the Medic walks to within 3.2m of a hurt infantry unit and
  restores EVERY part to full, wrecked non-critical parts to a third; the Engineer ("Mechanic" for Vanguard) does
  the same for vehicles, aircraft, emplacements and the base. Medic $220, Engineer $220 (the passive aura stays as
  a trickle). The bot's medics/engineers treat the most valuable wounded ally first (`aiTreatTarget`).
- **Placing** (`PLACEABLES` in `units.ts`, `sim.queuePlace`, instant, 1 AP + cost, within `reach`, T turns the
  rotatable ones): Demolitionist **Charge** $45 (a `cover` of kind `charge`: fused 3 turns, blows when shot, huge
  throwing blast, hurts everyone), Pad Tech **Pad** $40 (zone `sim.pads`: infantry that stop or land on it are launched 8m
  along its yaw, chains up to 3, ring-out kills), Oil Rigger **Slick** $50 (zone `sim.oilSlicks`: any blast/fire/round
  ending in it lights it: a burn zone of 18 a turn for 3 turns), Fortifier **Barrier** $40 (two tough `cover` blocks across
  the facing). Caps per side: 4 charges, 4 pads, 3 slicks, 3 barriers. Pads, slicks and charges ride `serialize()`.
- **Rocketeer** (`bazooka`, $300): flat rocket, 64 damage, x1.5 against vehicles (`UnitStats.antiArmor`).
- **Manned emplacements** (`gunpost`, `mortarpit`; defenses $90 / $140): an emplacement acts only while a trooper
  crews it (`sim.queueMan`; order `man`: walk up, crew; `queueDismount` = the Leave card). A crewed post gets 1 AP a turn,
  its crew none (`refreshMounts`); a post belongs to whoever crews it; it frees itself if the crew dies or is thrown
  clear. Every map starts with a mirrored pair of neutral Gun Posts on the flanks (`placeFieldMounts`). Bots crew a free
  post with a foe inside its reach (`aiMountTarget`); they never build one.
- **Who gets what:** Vanguard: Mechanic, Pad Tech, Rocketeer, Gun Post. Syndicate: Blaster (demo), Slickster (oil),
  Rocketeer ("Tank Hunter"), Mortar Pit. Bastion: Engineer, Mason (barriers), Demolisher (demo), Gun Post.
  The bot does not yet place charges, pads, oil or barriers (deferred, `docs/next-steps.md`).
- **Balance:** the self-play damage-per-dollar band cannot see a utility unit's worth, so the four field hands are
  `UNGATED` in `balance.test.ts` (printed, not gated); the Rocketeer is gated.
- **Audio** (`src/audio.ts`, `src/music.ts`, `public/audio`, credits in `ATTRIBUTION.md`, rebuild `npm run art:audio`, needs ffmpeg).
  - *Sources:* recorded CC0 samples play over every synthesized voice, which stays as the fallback. Every sample is peak-normalised
    to -3 dBFS and the recordings differ by 10+ dB in energy, so loudness is set in ONE table, `GROUP_GAIN`, from each group's measured
    RMS (`scripts/audio-stats.py`): deep boom > cannon = blast > crack > pop > rifle > carbine = pellet > pistol, machine gun held back.
  - *One voice per weapon* (`GUN_VOICES`, pure `voiceFor`): the same few recordings pitched and weighted per shooter (a marksman's
    rifle, scout and jumper carbines pitched up, pistols for the field hands, a deep MG, tank / siege gun / mortar pit / base relay at
    four pitches, flak cracks, rocket and flame synthesized, a hand grenade is a swish). `audio.test.ts` fails if an armed unit has no
    voice, if fewer than 20 distinct voices remain, or if the loudness order breaks.
  - *Hits and blasts:* a hit sounds like what it hit (`impactClass`: flesh, hull, concrete, wood, by the entity under the effect);
    an explosion's radius picks pop, blast or deep boom (`blastGroup`); off-screen sounds play at 35%. Oil catching, placing, a charge's
    fuse tick, healing, a bounce pad and a trooper settling into a post each have their own sound.
  - *Movement bed:* quiet footfalls, a track rumble and a rotor whirr under the units moving in view (`moveBed`).
  - *Music:* menus share a pool; each map has three tracks, one picked at random when the battle starts (`MAP_TRACKS`), the next
    follows when it ends; tracks are loudness-matched to -20 LUFS, fade out and in at scene changes, duck under the result stinger.
    Sound effects and Music are separate buses and sliders; mute gates both.
- **Visuals:** a shove is a stagger (lean and recover, upright on landing); a real throw is a full tumble about the
  axis across the throw; a pad launch is an upright leap. Treating plays the `aid` pose (tool lifts, body leans in); a placed
  charge/barrier drops in with a small overshoot and kicks dust, pads and oil fade up. A queued shot's line ends on the aimed PART (`orderAimPoint`).

## FACTION TRAITS and smarter field play (2026-10-03, second pass)

- **Unit traits** (`FactionDef.unitMods`, `applyFactionMods`, `CombatEntity.mods`, `unitModText`): the same unit is not the same
  unit. Vanguard is quick and light (troopers +12% speed, -5% HP; corpsman +20% speed; tank +10% speed, -8% HP; gunship +8% damage),
  Syndicate hard-hitting and brittle (raider +1 grenade, -8% HP; striker / sapper / flamer +10% damage; -8% HP on the glass), Bastion
  tough, slow and long-ranged (guardsman +12% HP, -8% speed; mortar and artillery +10% range; tank +12% HP). Multipliers are held to
  0.88-1.2 by `factionMods.test.ts`; the Deploy card names the faction's trait for each unit.
- **Batch 3, content (2026-10-03).** Eight new troop types: the **Runabout** (light car: 13m a move, four riders and a gunner seat, its MG
  fires only with a gunner aboard; `carrierCapacity`) and the **Turret Tech** (two **sentries** a sortie: small auto-turrets that shoot the nearest
  foe by themselves each turn and pack up after 4) are shared by every faction; each faction owns two more: Vanguard the **Hornet** (light
  tank, no ram) and the **Ricochet Gunner** (a hit glances on to two more foes within 3.2m, a warm bullet, never a beam); Syndicate the
  **Sledge** (Slam: every foe within 3m is hurt and flung up to 8m, can ring out) and the **Bounty Hunter** ($50 a kill); Bastion the
  **Ironclad** (tower shield: bullets from the front 150 degrees do 40%, blasts go round) and the **Trencher** (Dig: every trooper within 4m
  digs in). **Burning** is now a status (`entity.burning`): flamers, flame posts, napalm and burning ground set INFANTRY alight for three
  turns of 8, machines and aircraft do not burn, water or a medic puts it out. **Posts**: Rocket Posts and Flame Posts join Gun Posts as map
  pairs (`placeFieldMounts`, one band of the board each) and as base defenses (`isMountKind`). **Strikes**: EMP Burst (vehicles and defenses lose
  next turn), Minefield Drop, Medevac (full heal, up), Sentry Drop, Rail Strike (3 rods, 95 each). **Base options** (`BASE_UPGRADES`): Armor I/II
  (+30% health each), the **Fortress Cannon** (a `cannon` weapon part: 120-damage shell every second turn at the dearest ground foe in 40m, costs
  no base order), the **Watch Radar** (enemy orders revealed every turn). The bot buys armour then the cannon with an army out.
- **The tech tree (2026-10-03)**: 29 nodes in four branch columns, each layer opening units / defenses / strikes, six exclusive pairs that
  change what you can field (Fire Discipline vs Demolitions, Field Works vs Field Hospital) and five upgrade pairs. Recon -> Sharpshooters (Ricochet,
  Bounty, Rail Strike), Radar Net (EMP, Watch Radar), the flak and spotter line. Assault -> Shock Troops (Jump, Rocketeer, Sledge, Ironclad, Rocket Post),
  Ordnance -> Fire Discipline | Demolitions. Motor Pool (Runabout, Hornet, APC) -> Armor Bay (Tank, Bunker, Lance) -> Siege / Air Wing (also need
  Recon). Support Wing -> Field Works | Field Hospital. `tech.test.ts` pins the shape (depth, exclusive pairs, deep end costs most).
- **Achievements (2026-10-03)**: every medal has Armory `points` (shown on the card, paid once on unlock); the **Arsenal** page counts what the sim tallies
  in `sim.stats` (slams, thrown, burned, sentries, ricochets, bounties, clashes, cannon shots, hops, deployed kinds, researched nodes, calls ...);
  `commander.liveCheck` unlocks counted medals the moment their tally is met, mid-battle, with a corner toast (`announceMedal`, `.achieve-toast`).
- **Round 1 of batch 3 (2026-10-03)**: a crewed post gets TWO actions a turn and its crew keeps ONE, spent only to climb out (leaving costs 1,
- **Pulses are not explosions (review, 2026-10-03)**: an EMP burst, a medic or engineer aura and a smoke shell used to draw as a full fireball with a scorch, a shove and an explosion sound (a medic healing next to a friend looked like a shell landing). `PULSE_EMP` / `PULSE_HEAL` / `PULSE_SMOKE` blasts (`isPulseBlast`) now draw ring(s) and flecks in cold blue, healing green or soft grey (`makePulse`), with no scorch, no shove and a quiet sound. The "rounds collide in mid-air" log line is one per shooter pair per turn, and the "sandstorm / barrage next turn" banners are gone (the forecast chip says it).
  not the whole turn); the crew is never a blocker or a casualty of its own post's line of fire (`crewId` exclusions in
  `firstEntityBetweenShot` / `firstEntityHitBySegment` / `firstExplosiveProximity`; the "Friendly fire risk" warning at 2.5m was the
  crew standing in the line), and the barrel starts 0.7m out of the ring. `isMountKind` replaces the hard-coded gun-post / mortar-pit
  pairs. Selecting a target always shows its part health (More / Less is gone), the base panel lost "One base order a turn." and the
  faction **doctrine name** is no longer shown anywhere (the rule stays in the card tooltip). Recon Sweep: $60, 2-turn cooldown, and it
  marks every foe for the next turn. Two rounds meeting in mid-air now draw a `clash` effect by family (`CLASH_SPARK` / `CLASH_BOLT` /
  `CLASH_BLAST`: spark star, sniper shock ring, fireball and smoke) with sound and a camera nudge. A real throw (blast or direct hit,
  2.2m+) flies on a true arc with the head leading, lands flat on its back with dust, skids, and gets up (a 4.5m+ throw turns a
  backflip first); knockback reach went up (`KNOCKBACK_MAX` 6, direct hit 7m).
- **Bot, Hard brain: the whole toolkit** (2026-10-03, round 3; `aiX.moves` switches it off). Every order a player has, with the rule for when it pays:
  HOP (`aiHopAct`: across a gap or up a ledge too tall to walk, or onto a perch beside the fight, only when it clearly beats the walk);
  PUSH (`aiShoveAct`: a foe with water or the edge behind it, or one of our own mines / burning ground / gas / charges a shove away);
  RAM (a tank with infantry or a nearly dead vehicle on its hull, or with its gun gone); SMOKE (a mortar screens a friend that three
  guns, or two when behind, are working over); MINE (a sapper holding with foes 3-14m off); CROUCH (a trooper standing its ground
  under fire with an action point spare); HULL DOWN (a tank that has fired and holds the target in reach stays put, unless it is
  winning 1.5x); CARRY (an APC or transport boards an idle rifleman while far from the fight and sets its troops down within 15m);
  BAYONET (a disarmed trooper adjacent to a foe strikes); plus the older ones: heal / repair, man a post, lay field items, strikes,
  bomb runs, defenses, research. Not used on purpose: the Drone Op's recon pulse (the bot sees everything already) and the artillery
  deploy (the sim plants it by itself). Normal and Easy keep their old toolkit so the tiers stay apart. Over 48 seeded games the full
  set changed nothing against the Normal bot (33 wins / 5 losses either way): it is behaviour, not a power spike. In those games the bot
  crouched 740 times, hopped 152 and shoved 104 (up from 59); ram / smoke / mine / carry did not come up because the bot rarely buys those
  units, so `aiBrains.test.ts` stages each one.
- **Bot, Hard brain: posts and posture** (2026-10-03, round 2). When it pushes in, `aiBestPost` scores every spot within one move
  (height over the nearest foe, cover toward it, foes that can reach the spot minus friends standing by, whether it can still
  shoot from there, progress to the goal) and walks to the best, only if clearly better than staying. Measured over 48 seeded
  games against the Normal bot (hard as the enemy): plain marching 30 wins / 6 losses, posts on the way in 31 / 1; letting a
  unit that has already fired scoot to a post lost ground (17 / 18), so firing units still hold and press, and that variant is
  gone. `aiStrengthRatio` (cost x health) below 0.75 puts it on posture HOLD: it falls back to within 14m of home and only
  engages what comes within 1.2x its range (neutral in the same games, it matters when the bot is genuinely behind).
  `enemyTroopPreference` now answers armour with Rocketeers first and a dug-in player (2+ turrets / bunkers / posts) with
  artillery and mortars. `aiX.post` / `aiX.posture` switch each off. A hull also never ends an AI move brushing a sheer face.
- **Bot, Hard brain only** (Normal is untouched so the balance band holds): field hands lay their item where it hurts (`aiPlaceAct`: oil
  across the foe's lane, a barrier ahead of the line, a charge in front of them, only with $120 to spare); a trooper with a foe at the
  water's edge or the map edge behind it shoves it (`aiShoveAct`, finally); and bots treat a charge, a foe's oil and a foe's pad as
  danger and path around them (`aiDangerAt`).
- **Ambience** (`Sfx.setAmbience`): each map has its own air (dry desert wind, furnace roar and a distant clank, leaf breeze and the
  odd bird, cold gusts, a hollow temple drone, far-off guns); cash caches chime.

## OWNER BATCH 2026-10-03, third pass (controls, rounds, sound)

- **Hop** (`sim.queueLeap`, `leapRange`, `leapUp`, order `move` with `leap: true`, key J, card "Jump"): every trooper but the jump trooper
  can arc a few metres over low cover and up onto a ledge (3.6m x sqrt(speed / 6.5): a scout ~4.9m and ~1.8m up, a heavy ~3.1m and ~1.2m).
  It shares the jet-pack arc (airborne for the hop), lands softly (the slam is the jump trooper's), and refuses with a reason (too high,
  no room, water). `leap.test.ts`.
- **Blasts throw troopers**: any real explosion throws a trooper back at least a hop (0.9-2.5m by falloff), and a rocket or shell that HITS one
  throws it away from the shooter (up to 5.5m); armour and structures do not move.
- **Rounds** (`projectileFx.ts`): no long tail. Each weapon's round is its own compact shape (`ROUND`): warm dash (rifle), thin pale dart
  (carbine), bead (pistol), fat alternating orange-red slugs (MG), a long white needle with a bright collar (marksman), a finned rocket with a
  short jet (bazooka, family `rocket`). Small-arms ribbons are 0.3-1.3m and attached.
- **Circles**: rings are densified (a vertex every ~0.15m) and the triangles that span a ledge are dropped (`LEDGE_SPAN`), so a ring breaks
  cleanly at a lip instead of climbing the cliff as shards; the head-ring over every unit and the base is gone (the group stays for the sniper mark).
- **KIA** is only for a unit that died; a broken part reads "<PART> DOWN".
- **Menus**: the set-up summary refreshes AFTER the pick is recorded (it showed the previous pick); `smoke:flow` flips every mode both ways and
  asserts chip, blurb and summary agree. Right-click is Back everywhere.
- **Controls**: Tab walks Home Base then every unit; H = Home Base; 1-9 pick the numbered card of a unit's actions or the Home Base's open tab
  (cards wear their number); [ and ] flip the base tabs; J hop, P push, Z undo the last order, Q / E turn the camera; clicking a field cache with
  Move armed walks onto it. When every unit's AP is spent the End Turn button pulses "All set" with a chime.
- **Cursor**: inked toon cursors (arrow, pointer, a reticle for attacks and enemies, a footprint ring for move / place orders), `body.cursor-aim` /
  `cursor-move`. **Title screen**: a slow sway across a front arc, not a 360 orbit.
- **Sound**: the real recorded firearms ("The Free Firearm Sound Library") replace the pitched-down fireworks for guns: one recording per kind (AR-15
  recruit, SMG scout, Tikka jumper, rotating Mosin / Savage / Arisaka for the marksman, an AK burst for the heavy gunner (one clip per burst),
  pistols and revolvers for the field hands, shotguns for the sapper, a lever rifle for turrets, a PPSh burst for the gun post). Interface sounds are
  Kenney's: hover, press, unit pick, confirm, back, error, toggle, deploy, turn, all-set, win, lose. Menus have sound now too.

## THREE AI BRAINS (2026-09-22) — difficulty is intelligence first, stats second

`aiProfile()` in sim.ts. Before this, Normal and Hard ran the SAME brain and differed only in stats.
- **Easy**: nearest-target fire, no cover, no retreat, random purchases, and ~30% of its units
  hesitate each turn (`easyBrain` skip) — the bot a new player learns on.
- **Normal**: focus fire, cover-biased advances, crippled units retreat, reactive economy (wishlist
  ranked by cost × position so counters at the head win; saves only for research once it has 4+ units
  and is not out-built, and for a wanted unit only if affordable next turn).
- **Hard** (`tactical`): Normal plus — dodges this turn's telegraphed strikes / burn zones / gas
  (`aiDangerAt`, `aiEscapePoint`, never ends a move in one), finishes what it can kill this turn
  (measured against the CORE, not summed part HP), aims at the part that kills or disarms
  (`aiBestPart`), kites fragile ranged units, pulls defenders onto intruders near its base, throws
  grenades at clusters / dug-in targets, and runs a deterministic income-first economy.
- Stat mods on Hard were cut (HP 1.3→1.15, damage 1.28→1.12, income 1.45→1.25): the brain carries it.
- Measured by one-off self-play at EQUAL stats (`brainOverride` + `debugCommandAsAi(brain)`, 6 maps ×
  2 seeds × both seats): Hard beat Normal 19-2, Normal beat Easy 18-5, Hard beat Easy 20-3.
  `debugAiTraits` toggles single traits — that is how the old "smart economy" was caught LOSING to the
  greedy one 2-10. Rerun that comparison after any AI change; it is not a gate (≈3 min).
- RNG discipline: every roll stays exactly where it was drawn for easy/normal (short-circuit order
  preserved), so their replays and seeded tests do not shift when Hard changes.
- `aiBrains.test.ts`: Hard dodges a barrage and finishes a killable target.

## LOCAL 2 PLAYERS (hotseat, 2026-09-22)

The Skirmish set-up page's **Opponent** row (vs Bot / Local 2 Players — not a main-menu button, owner 2026-09-22) switches to a Player 2 faction row (no difficulty —
forced Normal so the enemy-side difficulty modifiers are all 1).
`sim.hotseat` (serialized) stops `endTurn` from queueing AI orders. Both players start with
`START_MONEY_PLAYER` (the bot's smaller purse is a handicap for the human, not for Player 2).
Each command phase is planned TWICE: a handoff card ("Player N — your orders"), that player plans,
End Turn ("Pass to P2") hands to the other seat, the second End Turn resolves. **Who plans first
alternates by turn parity** (P1 odd, P2 even) because the second planner watched the first on the
same screen — except after a recon pulse: `revealedTeam` records whose drone flew, that seat plans
SECOND and `enemyIntents()` returns the other human's real queued orders (no AI dry-run).
**The second planner must not see the first one's plan** (2026-09-23 audit; `smoke:hotseat`
asserts it through `__rht.overlayCounts()` and is fault-injection proven): `syncOrders` draws only
`"player"`-side orders, and
`swapSides()` drops the outgoing seat's log lines (`logSeq` / `seatLogMark`) and its armed
intent / pending deploy / build / support. What a player builds or deploys is physically on the
board and stays visible; alternation is what keeps that fair. The HUD's turn chip names the seat
("Turn 3 Player 2"), the vs-bot INTEL toast is off (the handoff card lists the other side's tech as
of the turn start instead), each seat keeps its own camera (Player 2's first view is turned half
round), and `reset()` / Play Again flip the seats back before reconfiguring and reopen on Player 1.
Log lines and battle-log sections name "Player 1" / "Player 2", never "You" / "Enemy".
Player 2 plans through the ordinary UI via `sim.swapSides()` (`flipTeams`: entities, mines,
treasury, factions, mode scores / hill holders / flag owners). The sim always RESOLVES and SAVES
unswapped (`serialize` flips back around the write), so victory = Player 1, defeat = Player 2.
No medals or points from hotseat games. Tests: `hotseat.test.ts`; `npm run smoke:hotseat` (in
`smoke:core`); `shots:gpu versus`.
- **Air bombing (2026-10-03)**: a gunship or bomber bombs any ground point within its bomb reach (11 / 12m) from where it hovers: 1 AP,
  NO flight. Click picks the spot (or the ground under a foe), the line from the rack and the splash are drawn, Confirm queues it
  (same pick-then-confirm as lobs and shells). The bomb leaves the rack under the airframe and falls steeply; it ignores aircraft. A bomber's
  carpet is three bombs across the spot along the line to it. The Hard bot bombs a clump in reach without moving.
- **Muzzles (2026-10-03)**: `MUZZLE_LOCAL` in sim.ts is the one table of where each gun really is (x right, z forward, y above `elevation`;
  an aircraft's `elevation` is its body centre). Every round, preview line, queued-order line and flash starts there (`muzzleFor`).
  `npm run shots:gpu -- muzzlecheck` measures the gap from each shooter's round origin to its drawn weapon mesh (should be ~0).
- **Intro**: the title pan owns the camera (`guideTo` is off while `menuDrift`); a boot veil hides the canvas until the model kits are in
  and warmed, then fades it in once; `probe:intro` fails on a camera jump, a veil that never lifts, or a snap when opening Play.
