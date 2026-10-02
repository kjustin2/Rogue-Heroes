#!/bin/bash
# Transcode the fetched CC0 audio (scripts/audio-fetch.sh) into public/audio. ffmpeg required.
#   bash scripts/audio-fetch.sh <raw-dir> && bash scripts/audio-build.sh <raw-dir>
# SFX: mono 32k Vorbis, one shot per file. Music: stereo Vorbis q2, long tracks trimmed to 3:30 with a fade.
set -e
RAW="$1"; OUT="$(dirname "$0")/../public/audio"
[ -d "$RAW/music" ] || { echo "run audio-fetch.sh first"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/sfx" "$OUT/music"
enc() { ffmpeg -v error -y "$@"; }
# ---- music ----
for f in "$RAW"/music/*; do
  n=$(basename "$f"); n="${n%.*}"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"); dur=${dur%.*}
  if [ "$dur" -gt 210 ]; then enc -i "$f" -t 210 -af "afade=t=out:st=204:d=6" -c:a libvorbis -q:a 2 "$OUT/music/$n.ogg"
  else enc -i "$f" -c:a libvorbis -q:a 2 "$OUT/music/$n.ogg"; fi
done
# ---- sfx ----
# One shot from each long gun recording: skip the lead-in, keep the report and its tail.
shot() { enc -i "$1" -af "silenceremove=start_periods=1:start_threshold=-28dB:start_silence=0.02,atrim=0:$3,afade=t=out:st=$(awk "BEGIN{print $3-0.25}"):d=0.25,loudnorm=I=-16:TP=-1.5" -ac 1 -ar 32000 -c:a libvorbis -q:a 3 "$OUT/sfx/$2.ogg"; }
short() { enc -i "$1" -af "loudnorm=I=-16:TP=-1.5" -ac 1 -ar 32000 -c:a libvorbis -q:a 3 "$OUT/sfx/$2.ogg"; }
shot "$RAW/sfx/gunshots/sounds/mosin.wav" rifle 1.1
shot "$RAW/sfx/gunshots/sounds/sks.wav" carbine 0.9
shot "$RAW/sfx/gunshots/sounds/cz.wav" pistol 0.8
shot "$RAW/sfx/gunshots/sounds/shotty.wav" pellet 0.69
for i in 01 02 03; do short "$RAW/sfx/bangs/shot_$i.ogg" "bolt_$i"; done
for i in 01 02 03 04 05; do short "$RAW/sfx/bangs/cannon_$i.ogg" "cannon_$i"; done
for i in 01 02 03 04 05 06 07 08 09 10; do short "$RAW/sfx/bangs/bang_$i.ogg" "blast_$i"; done
for i in 01 02 03 04 05 06; do short "$RAW/sfx/bangs/fw_$i.ogg" "boom_$i"; done
K="$RAW/sfx/kenney_impact/Audio"
for i in 000 001 002; do
  short "$K/impactMetal_medium_$i.ogg" "hitmetal_$i"
  short "$K/impactPunch_heavy_$i.ogg" "hitpunch_$i"
  short "$K/impactSoft_heavy_$i.ogg" "hitsoft_$i"
  short "$K/impactPlate_heavy_$i.ogg" "hitplate_$i"
  short "$K/impactWood_heavy_$i.ogg" "hitwood_$i"
done
du -sh "$OUT/sfx" "$OUT/music"
