#!/bin/bash
# Transcode the fetched CC0 audio (scripts/audio-fetch.sh) into public/audio. ffmpeg required.
#   bash scripts/audio-fetch.sh <raw-dir> && bash scripts/audio-build.sh <raw-dir>
# SFX: every file is peak-normalised to -3 dBFS (the sources clip at +3 dB and differ by 10+ dB), so loudness is
# decided in ONE place: the gain table in src/audio.ts (VOICES / IMPACT_GAIN). Music: loudness-matched to -20 LUFS
# so no track jumps out, long tracks trimmed to 3:30 with a fade.
set -e
RAW="$1"; OUT="$(dirname "$0")/../public/audio"
[ -d "$RAW/music" ] || { echo "run audio-fetch.sh first"; exit 1; }
rm -rf "$OUT/sfx" "$OUT/music"; mkdir -p "$OUT/sfx" "$OUT/music"
enc() { ffmpeg -v error -y "$@"; }
# ---- music ----
for f in "$RAW"/music/*; do
  n=$(basename "$f"); n="${n%.*}"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"); dur=${dur%.*}
  if [ "$dur" -gt 210 ]; then enc -i "$f" -t 210 -af "afade=t=out:st=204:d=6,loudnorm=I=-20:TP=-2:LRA=11" -c:a libvorbis -q:a 2 "$OUT/music/$n.ogg"
  else enc -i "$f" -af "loudnorm=I=-20:TP=-2:LRA=11" -c:a libvorbis -q:a 2 "$OUT/music/$n.ogg"; fi
done
# ---- sfx ----
# peak-normalise to -3 dBFS: measure, then apply the exact gain.
norm() { # in out [filters-before]
  # Mono + 32k FIRST, then measure: a stereo downmix and the resample both move the peak.
  local pre="${3:-anull},aformat=channel_layouts=mono:sample_rates=32000"
  local mx; mx=$(ffmpeg -v info -i "$1" -af "$pre,aformat=sample_fmts=flt,astats=measure_perchannel=none:measure_overall=Peak_level" -f null - 2>&1 | grep "Peak level dB" | tail -1 | sed 's/.*: //')
  local g; g=$(awk "BEGIN{print -3 - ($mx)}")
  enc -i "$1" -af "$pre,volume=${g}dB" -c:a libvorbis -q:a 3 "$OUT/sfx/$2.ogg"
}
# One shot from each long gun recording: skip the lead-in, keep the report and its tail.
shot() { norm "$1" "$2" "silenceremove=start_periods=1:start_threshold=-28dB:start_silence=0.02,atrim=0:$3,afade=t=out:st=$(awk "BEGIN{print $3-0.25}"):d=0.25"; }
shot "$RAW/sfx/gunshots/sounds/mosin.wav" rifle 1.1
shot "$RAW/sfx/gunshots/sounds/sks.wav" carbine 0.9
shot "$RAW/sfx/gunshots/sounds/cz.wav" pistol 0.8
shot "$RAW/sfx/gunshots/sounds/shotty.wav" pellet 0.69
B="$RAW/sfx/bangs"
# Sorted by measured tone and length (scripts/_sfx_stats.py): deep and long = boomdeep, mid = blast, bright and short = pop.
n=1; for f in bang_03 fw_04 fw_06; do norm "$B/$f.ogg" "boomdeep_0$n"; n=$((n+1)); done
n=1; for f in bang_01 bang_07 bang_09 bang_10 bang_08 fw_01 fw_05; do norm "$B/$f.ogg" "blast_0$n"; n=$((n+1)); done
n=1; for f in bang_02 bang_04 bang_05 bang_06 fw_02 fw_03; do norm "$B/$f.ogg" "pop_0$n"; n=$((n+1)); done
n=1; for f in cannon_01 cannon_02 cannon_04; do norm "$B/$f.ogg" "cannon_0$n"; n=$((n+1)); done
n=1; for f in cannon_03 cannon_05; do norm "$B/$f.ogg" "crack_0$n"; n=$((n+1)); done
for i in 01 02 03; do norm "$B/shot_$i.ogg" "bolt_$i"; done
K="$RAW/sfx/kenney_impact/Audio"
for i in 000 001 002; do
  norm "$K/impactMetal_medium_$i.ogg" "hitmetal_$i"
  norm "$K/impactPunch_heavy_$i.ogg" "hitpunch_$i"
  norm "$K/impactSoft_heavy_$i.ogg" "hitsoft_$i"
  norm "$K/impactPlate_heavy_$i.ogg" "hitplate_$i"
  norm "$K/impactWood_heavy_$i.ogg" "hitwood_$i"
done
du -sh "$OUT/sfx" "$OUT/music"
