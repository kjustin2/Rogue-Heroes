"""Cut single shots and bursts out of the long firearm recordings ("The Free Firearm Sound Library", CC0).

    python scripts/audio-slice.py <raw-dir>/sfx2/firearms/"Prepared SFX Library" <out-dir>

Each source file holds many shots at several mic positions. For every weapon this writes `<group>_<n>.wav`
(mono, 44.1 kHz): up to 3 clean single shots, or (for the full-auto guns) the best burst. Onsets are found on a
5 ms peak envelope with a refractory gap; a shot runs from just before its onset to its tail (or the next onset).
"""
import os, subprocess, sys, wave
import numpy as np

SR = 44100
FF = "ffmpeg"

# folder -> (group, mode, tail seconds)
WEAPONS = {
    "AR-15": ("ar15", "single", 1.5),
    "AK-47": ("ak47", "single", 1.5),
    "SKS": ("sks", "single", 1.5),
    "Carl Gustav M45": ("carlgustav", "single", 1.0),
    "Tikka": ("tikka", "single", 1.6),
    "Marlin 336": ("marlin", "single", 1.6),
    "Model 1894": ("lever1894", "single", 1.5),
    "Mosin Nagant": ("mosin", "single", 2.2),
    "Savage 10 .300 Blackout": ("savage", "single", 2.0),
    "Arisaka": ("arisaka", "single", 2.0),
    "1911": ("colt1911", "single", 1.1),
    "Walther PPQ": ("ppq", "single", 0.9),
    "Bersa": ("bersa", "single", 0.9),
    "Ruger Mark III": ("ruger22", "single", 0.8),
    "Smith & Wesson 642": ("sw642", "single", 1.0),
    "Ruger Single Six": ("singlesix", "single", 1.1),
    "1917": ("m1917", "single", 1.3),
    "Mossberg": ("mossberg", "single", 1.6),
    "Model 12": ("model12", "single", 1.6),
    "Nova": ("nova", "single", 1.6),
}
BURSTS = {"AK-47": "ak47burst", "PPSh": "ppshburst"}


def load(path):
    raw = subprocess.run([FF, "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def envelope(x, win=0.005):
    n = int(SR * win)
    m = len(x) // n
    return np.abs(x[: m * n]).reshape(m, n).max(axis=1), n


def onsets(x, gap=0.35, rel=0.3):
    env, n = envelope(x)
    peak = env.max()
    if peak <= 0:
        return []
    thr = peak * rel
    out, last = [], -1e9
    i = 0
    while i < len(env):
        if env[i] >= thr and (i * n / SR) - last >= gap:
            # climb to the local maximum within 15 ms so the onset is the true attack
            j = i
            while j + 1 < len(env) and env[j + 1] > env[j] and j - i < 4:
                j += 1
            out.append(i * n / SR)
            last = i * n / SR
            i += int(gap * SR / n)
        else:
            i += 1
    return out


def write(path, x):
    x = x / max(1e-6, np.abs(x).max()) * 0.7
    fade = int(SR * 0.12)
    x = x.copy()
    x[-fade:] *= np.linspace(1, 0, fade)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def main(src, out):
    os.makedirs(out, exist_ok=True)
    for folder, (group, mode, tail) in WEAPONS.items():
        shots = []
        for f in sorted(n for n in os.listdir(os.path.join(src, folder)) if n.lower().endswith(".wav")):
            x = load(os.path.join(src, folder, f))
            ons = onsets(x)
            for k, t in enumerate(ons):
                end = t + tail if k + 1 >= len(ons) else min(t + tail, ons[k + 1] - 0.04)
                seg = x[max(0, int((t - 0.012) * SR)): int(end * SR)]
                if len(seg) > SR * 0.25:
                    shots.append((float(np.abs(seg).max()), seg))
        shots.sort(key=lambda s: -s[0])
        # three takes that are not the single loudest outlier: take from the top third, spread out
        chosen = shots[: max(3, len(shots) // 3)][:: max(1, len(shots) // 9)][:3] or shots[:3]
        for n, (_, seg) in enumerate(chosen, 1):
            write(os.path.join(out, f"{group}_{n:02d}.wav"), seg)
        print(f"{group}: {len(chosen)} shots (of {len(shots)})")
    for folder, group in BURSTS.items():
        best = None
        for f in sorted(n for n in os.listdir(os.path.join(src, folder)) if n.lower().endswith(".wav")):
            x = load(os.path.join(src, folder, f))
            ons = onsets(x, gap=0.05, rel=0.25)
            run = [ons[0]] if ons else []
            for t in ons[1:]:
                if t - run[-1] < 0.2:
                    run.append(t)
                else:
                    if best is None or len(run) > best[0] and len(run) <= 14:
                        best = (len(run), x, run[0], run[-1])
                    run = [t]
            if len(run) >= 5 and (best is None or (len(run) > best[0] and len(run) <= 14)):
                best = (len(run), x, run[0], run[-1])
        if best:
            _, x, a, b = best
            write(os.path.join(out, f"{group}_01.wav"), x[max(0, int((a - 0.012) * SR)): int((b + 0.6) * SR)])
            print(f"{group}: burst of {best[0]} rounds, {b - a + 0.6:.2f}s")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
