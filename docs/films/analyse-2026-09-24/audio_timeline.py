"""Chronologie sonore d'un rendu de film : RMS global et énergie « voix » (300-3000 Hz)
par tranche de 0,5 s, à partir du MP4 enregistré par l'app. Usage : python3 audio_timeline.py <mp4>"""
import sys, subprocess, numpy as np
f = sys.argv[1]
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
sr = 16000; step = sr // 2
# passe-bande voix par FFT par tranche
out_rms, out_voice = [], []
for i in range(0, len(x) - step, step):
    seg = x[i:i + step]
    rms = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    tot = spec.sum() + 1e-9
    voice = spec[(freqs > 300) & (freqs < 3000)].sum() / tot
    out_rms.append(rms); out_voice.append(voice)
line1 = ' '.join(f'{t*0.5:.1f}:{r:.0f}' for t, r in enumerate(out_rms))
print('RMS dB par 0,5 s :'); print(line1)
# segments « forts » (> médiane + 6 dB) = événements sonores marqués
med = np.median(out_rms)
ev = [t * 0.5 for t, r in enumerate(out_rms) if r > med + 6]
print(f'médiane {med:.0f} dB ; tranches > médiane+6 dB : {ev}')
