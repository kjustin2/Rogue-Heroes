#!/bin/bash
# One-off audio fetch (all CC0). Raw files land in $1; the transcode step lives in scripts/build-audio.mjs.
D="${1:-.audio-raw}"; mkdir -p "$D/music" "$D/sfx"
O=https://opengameart.org/sites/default/files
get() { curl -fsSL --retry 2 -o "$2" "$1" && echo "ok $2" || echo "FAIL $1"; }
cd "$D/music"
get "$O/wowmenu.ogg" wowmenu.ogg
get "$O/wowchapter1.ogg" wowchapter1.ogg
get "$O/wowchapter2.ogg" wowchapter2.ogg
get "$O/WoWChapter3.ogg" wowchapter3.ogg
get "$O/battleThemeA.mp3" battleThemeA.mp3
get "$O/desert_loop_0.mp3" desert_loop.mp3
get "$O/Negev%20Desert%20Loop.wav" negev_desert.wav
get "$O/Negev%20Fight%20Loop.wav" negev_fight.wav
get "$O/Factory.ogg" factory.ogg
get "$O/march2_0.ogg" march2.ogg
get "$O/FantasyOrchestralTheme_1.mp3" fantasy_orchestral.mp3
get "$O/harvestseason_2.mp3" harvest_season.mp3
get "$O/Long%20Winter_0.mp3" long_winter.mp3
get "$O/155%20November_snow-33_tape_leveled.mp3" november_snow.mp3
get "$O/song18_0.mp3" crystal_cave.mp3
get "$O/Juhani%20Junkala%20-%20Epic%20Boss%20Battle%20%5BSeamlessly%20Looping%5D.wav" epic_boss.wav
cd "$D/sfx"
get "$O/sounds.zip" gunshots.zip
get "$O/25-CC0-bang-sfx.zip" bangs.zip
get "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip" kenney_impact.zip
