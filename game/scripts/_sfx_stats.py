import subprocess, glob, os, sys, numpy as np
FF = "ffmpeg"
def load(path):
    raw = subprocess.run([FF, "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "32000", "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32), 32000
def stats(path):
    x, sr = load(path)
    if len(x) == 0: return None
    peak = float(np.max(np.abs(x)))
    # duration until the envelope falls 40 dB below its peak
    env = np.abs(x)
    win = int(sr * 0.01)
    e = np.array([env[i:i + win].max() for i in range(0, len(env) - win, win)]) if len(env) > win else env
    above = np.where(e > peak * 0.01)[0]
    dur = (above[-1] + 1) * 0.01 if len(above) else 0
    spec = np.abs(np.fft.rfft(x[: min(len(x), sr)]))
    freqs = np.fft.rfftfreq(min(len(x), sr), 1 / sr)
    centroid = float((spec * freqs).sum() / max(1e-9, spec.sum()))
    rms = float(np.sqrt(np.mean(x[: int(sr * 0.5)] ** 2)))
    return peak, dur, centroid, rms
root = sys.argv[1]
for f in sorted(glob.glob(root + "/**/*.*", recursive=True)):
    if not f.lower().endswith((".ogg", ".wav")): continue
    s = stats(f)
    if s: print(f"{os.path.relpath(f, root):40s} peak {20*np.log10(s[0]+1e-9):6.1f}dB  tail {s[1]:5.2f}s  centroid {s[2]:7.0f}Hz  rms0.5 {20*np.log10(s[3]+1e-9):6.1f}dB")
