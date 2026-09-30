#!/usr/bin/env python3
"""Bibliothèque commune des kits de film PicoPop (remplace les copies build_kit*.py par film).
Applique les règles du PLAYBOOK §7 bis (montages finalisés de Nicolas, 29–30/09/2026) :

- PROFILS de dinosaure (`HEAVY` / `MEDIUM` / `AGILE`) : vitesse de marche, durée d'entrée, idle,
  échelle seul / face à un adversaire, amplitude des pas.
- `Kit` : ids déterministes (uuid5), helpers wp/travel/anim/zoom/rumble/shake/voice, EMPLACEMENTS
  de sons nommés (ambiance, événement, rugissement, musique) que Nicolas remplit à la main, et un
  `check()` qui signale : plan trop long après la dernière action, voix qui démarre avant l'action,
  héros trop petit/haut, vitesse incohérente avec le profil, plan de confrontation trop bavard.

Usage dans docs/films/<dino>/build_kit.py :
    from filmkit import Kit, HEAVY
    k = Kit('brachiosaurus', PROJECT, profile=HEAVY, anims={...}, voices={...}, facing='left')
    P = k.plan('P1', 'Presentation', 'videos/P1-web.mp4', duration_ms=10600)
    wp = k.wp(P, 'centre', 650, k.ground(581), k.scale_alone(), 'right')
    ...
    k.write(order=['P1', ...], intro_ms=1000, poster_ms=...)
"""
import json, os, sys, uuid
from dataclasses import dataclass, field

# ------------------------------------------------------------------ profils
@dataclass
class Profile:
    name: str
    walk_speed: float        # animSpeedMul d'une marche tranquille sur un trajet
    run_speed: float         # course / charge
    entry_ms: int            # durée d'une entrée en scène
    entry_from_offscreen: bool  # départ hors-champ (agile) ou point proche du bord (lourd)
    idle_speed: float
    scale_alone: float       # héros seul dans le cadre
    scale_vs_big: float      # avec un gros adversaire dans le cadre
    rumble_amp: float        # amplitude du rumble sur les pas
    exit_ms: int

HEAVY = Profile('lourd', walk_speed=1.1, run_speed=2.0, entry_ms=5500, entry_from_offscreen=False, idle_speed=0.8, scale_alone=1.1, scale_vs_big=0.85, rumble_amp=4, exit_ms=4000)
MEDIUM = Profile('moyen', walk_speed=1.8, run_speed=3.0, entry_ms=4000, entry_from_offscreen=False, idle_speed=0.8, scale_alone=1.15, scale_vs_big=0.8, rumble_amp=3, exit_ms=2500)
AGILE = Profile('agile', walk_speed=3.0, run_speed=4.0, entry_ms=1500, entry_from_offscreen=True, idle_speed=1.1, scale_alone=1.1, scale_vs_big=0.75, rumble_amp=1.5, exit_ms=1200)

OFF_L = {'kind': 'offscreen', 'side': 'left'}
OFF_R = {'kind': 'offscreen', 'side': 'right'}
FRAME_W, FRAME_H = 1280, 720
HERO_W_AT_1 = 500   # largeur approximative du héros (image 1254² ajustée à 720 px de haut) à l'échelle 1


class Kit:
    def __init__(self, film, project, profile, anims, voices, facing='right', music=None, sounds=None, here=None):
        self.film, self.project, self.p = film, project, profile
        self.here = here or os.getcwd()
        self.NS = uuid.uuid5(uuid.NAMESPACE_URL, f'picopop-film-{film}-{project[:8]}')
        self.anims = anims                      # nom → id d'animation (Idle, Walk, Action, …)
        self.voices = voices                    # nom bibliothèque → fichier local
        self.sounds = dict(sounds or {})        # autres sons fournis (nom → fichier)
        self.music = music                      # (nom, fichier, volume) ou None
        self.facing = facing
        self.plans = {}
        self.slots = []                         # emplacements de sons à remplir par Nicolas
        self.warnings = []

    def uid(self, key): return str(uuid.uuid5(self.NS, key))
    def sid(self, name): return self.uid('sound:' + name)

    # ---------------------------------------------------------- géométrie
    def ground(self, y): return y                       # y = ligne de sol LUE sur l'image du décor
    def scale_alone(self): return self.p.scale_alone
    def scale_vs_big(self): return self.p.scale_vs_big
    def hero_w(self, scale): return HERO_W_AT_1 * scale

    # ---------------------------------------------------------- plans et clips
    def plan(self, key, name, backdrop, duration_ms, transition=None, kind='calme'):
        pl = {'id': self.uid('plan.' + key), 'name': name, 'backdropFile': backdrop, 'cameraX': FRAME_W // 2,
              'transitionToNext': transition or {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': duration_ms,
              'waypoints': [], 'motion': [], 'anim': [], 'camera': [], 'soundTracks': [], '_key': key, '_kind': kind, '_events': []}
        self.plans[key] = pl
        return pl

    def wp(self, pl, name, x, y, scale, facing):
        w = {'id': self.uid(f"{pl['_key']}.wp.{name}"), 'x': x, 'y': y, 'scale': scale, 'facing': facing}
        pl['waypoints'].append(w); return w

    @staticmethod
    def W(w): return {'kind': 'waypoint', 'id': w['id']}

    def appear(self, pl, to):
        m = {'id': self.uid(f"{pl['_key']}.motion.appear"), 'startMs': 0, 'durationMs': 0, 'kind': 'appear', 'to': to}
        pl['motion'].append(m); return m

    def entry(self, pl, to_wp, side='left', start=0, duration=None, speed=None, animation='Walk'):
        """Entrée en scène selon le profil : lourd = point de départ proche du bord, lent ; agile = hors-champ, vite."""
        dur = duration or self.p.entry_ms
        if self.p.entry_from_offscreen:
            frm = OFF_L if side == 'left' else OFF_R
        else:
            frm = {'kind': 'free', 'x': -120 if side == 'left' else FRAME_W + 120, 'y': to_wp['y']}
        m = self.travel(pl, 'entree', start, dur, self.W(to_wp), easing='easeOut', animation=animation, speed=speed or self.p.walk_speed, frm=frm)
        self.rumble(pl, 'pas-entree', start, dur, self.p.rumble_amp, 3, anchor=self.A(m['id']))
        pl['_events'].append(('entrée', start + dur))
        return m

    def travel(self, pl, name, start, dur, to, easing='linear', animation='Walk', speed=None, frm=None):
        c = {'id': self.uid(f"{pl['_key']}.motion.{name}"), 'startMs': start, 'durationMs': dur, 'kind': 'travel', 'to': to,
             'easing': easing, 'animationId': self.anims[animation], 'animSpeedMul': speed if speed is not None else self.p.walk_speed}
        if frm: c['from'] = frm
        pl['motion'].append(c); pl['_events'].append((name, start + dur)); return c

    def advance(self, pl, name, start, from_wp, dx, dur=1200):
        """Le héros AVANCE vers l'adversaire qui recule (150–300 px, Walk ×2)."""
        w = self.wp(pl, name + '-wp', from_wp['x'] + dx, from_wp['y'], from_wp['scale'], from_wp.get('facing'))
        return self.travel(pl, name, start, dur, self.W(w), easing='easeOut', animation='Walk', speed=max(2.0, self.p.walk_speed))

    def anim(self, pl, name, start, dur, which, speed=None, fill='loop'):
        c = {'id': self.uid(f"{pl['_key']}.anim.{name}"), 'startMs': start, 'durationMs': dur, 'animationId': self.anims[which],
             'speedMul': speed if speed is not None else (self.p.idle_speed if which == 'Idle' else 1.0), 'fillMode': fill}
        pl['anim'].append(c)
        if fill == 'once-hold' or which not in ('Idle', 'Walk'): pl['_events'].append((name, start + dur))
        return c

    def action_before_video_event(self, pl, name, video_event_ms, which, lead_ms, speed=2.0, dur=2400):
        """Action du héros calée AVANT un événement de la vidéo (rugissement 1,5–2 s avant la fuite, coup 0,3 s avant l'impact)."""
        return self.anim(pl, name, max(0, video_event_ms - lead_ms), dur, which, speed, 'once-hold')

    def zoom(self, pl, name, start, dur, rect=None, zin=800, zout=1200):
        c = {'id': self.uid(f"{pl['_key']}.cam.{name}"), 'startMs': start, 'durationMs': dur, 'kind': 'zoom',
             'rect': rect or {'x': 290, 'y': 160, 'w': 700, 'h': 400}, 'zoomInMs': zin, 'zoomOutMs': zout, 'easing': 'easeInOut', 'maxZoom': 2.5}
        pl['camera'].append(c); return c

    def rumble(self, pl, name, start, dur, amp=None, hz=3, anchor=None):
        c = {'id': self.uid(f"{pl['_key']}.cam.{name}"), 'startMs': start, 'durationMs': dur, 'kind': 'rumble', 'amplitude': amp or self.p.rumble_amp, 'frequencyHz': hz, 'axis': 'both'}
        if anchor: c['anchor'] = anchor
        pl['camera'].append(c); return c

    def shake(self, pl, name, start, anchor=None, amp=18, hz=14, dur=1500):
        c = {'id': self.uid(f"{pl['_key']}.cam.{name}"), 'startMs': start, 'durationMs': dur, 'kind': 'shake', 'amplitude': amp, 'frequencyHz': hz, 'rotate': True, 'decay': 'expo'}
        if anchor: c['anchor'] = anchor
        pl['camera'].append(c); return c

    @staticmethod
    def A(clip_id, offset=0, edge='start'): return {'clipId': clip_id, 'edge': edge, 'offsetMs': offset}

    # ---------------------------------------------------------- sons
    def _track(self, pl, idx):
        while len(pl['soundTracks']) <= idx: pl['soundTracks'].append({'clips': []})
        return pl['soundTracks'][idx]['clips']

    def voice(self, pl, name, start, sound, dur, offset=0, volume=1.3, track=0):
        c = {'id': self.uid(f"{pl['_key']}.snd.{name}"), 'startMs': start, 'durationMs': dur, 'soundId': self.sid(sound), 'volume': volume, 'isSpoken': True}
        if offset: c['offsetMs'] = offset
        self._track(pl, track).append(c); pl['_events'].append(('voix ' + name, start + dur)); pl.setdefault('_voices', []).append(c); return c

    def sound(self, pl, name, start, dur, sound, volume=0.8, track=1, loop=False, anchor=None, fade_in=None, fade_out=None, rate=None):
        c = {'id': self.uid(f"{pl['_key']}.snd.{name}"), 'startMs': start, 'durationMs': dur, 'soundId': self.sid(sound), 'volume': volume}
        if loop: c['loop'] = True
        if anchor: c['anchor'] = anchor
        if fade_in: c['fadeInMs'] = fade_in
        if fade_out: c['fadeOutMs'] = fade_out
        if rate: c['rate'] = rate
        self._track(pl, track).append(c); return c

    def slot(self, pl, role, start, dur, note='', volume=0.6, track=2, loop=False):
        """EMPLACEMENT de son à remplir par Nicolas : mémorisé dans slots.md (pas de clip sans fichier)."""
        self.slots.append({'plan': pl['name'], 'role': role, 'startMs': start, 'durationMs': dur, 'volume': volume, 'loop': loop, 'note': note})

    def ambience(self, pl, note=''):
        self.slot(pl, 'AMBIANCE', 0, pl['durationMs'], note or 'ambiance du décor (loop, fade-in 300 ms)', volume=0.5, track=2, loop=True)

    # ---------------------------------------------------------- contrôle qualité
    def check(self):
        w = self.warnings
        for pl in self.plans.values():
            last = max([t for _, t in pl['_events']], default=0)
            if pl['durationMs'] - last > 2500:
                w.append(f"{pl['name']} : {(pl['durationMs'] - last) / 1000:.1f} s de vide après la dernière action ({last} ms) — raccourcir le plan à ≈ {last + 1800} ms")
            for v in pl.get('_voices', []):
                actions = [a for a in pl['anim'] if a['fillMode'] == 'once-hold' or a['animationId'] not in (self.anims.get('Idle'), self.anims.get('Walk'))]
                if pl['_kind'] == 'calme' and v['startMs'] < 1500 and actions:
                    w.append(f"{pl['name']} : la voix démarre à {v['startMs']} ms alors qu'il y a une action — l'action d'abord, la voix ensuite")
            if pl['_kind'] == 'confrontation' and len(pl.get('_voices', [])) > 1:
                w.append(f"{pl['name']} : plan de confrontation avec {len(pl['_voices'])} répliques — en garder ≤ 1")
            for wp in pl['waypoints']:
                if wp['scale'] < 1.0 and pl['_kind'] != 'confrontation':
                    w.append(f"{pl['name']} : héros seul à l'échelle {wp['scale']} — prévoir 1,1–1,25")
                if wp['y'] < 570 and wp['scale'] < 1.4:
                    w.append(f"{pl['name']} : y = {wp['y']} probablement au-dessus de la ligne de sol (lire l'image : 575–760 selon le décor)")
            for m in pl['motion']:
                if m['kind'] == 'travel' and m.get('animSpeedMul', 1) > self.p.run_speed + 0.01:
                    w.append(f"{pl['name']} : trajet à ×{m['animSpeedMul']} au-delà de la course d'un dino {self.p.name} (max ×{self.p.run_speed})")
        return w

    # ---------------------------------------------------------- sortie
    def write(self, order, intro_ms=1000, outro_ms=1000, poster_ms=None, out=None, footsteps=True, idle_speed=None, move_speed_px=None):
        sounds = [{'id': self.sid(n), 'name': n, 'file': f} for n, f in list(self.voices.items()) + list(self.sounds.items())]
        film = {'version': 4, 'plans': [], 'character': {'scale': 1, 'facing': self.facing, 'originU': 0.5, 'originV': 0.82},
                'sounds': sounds, 'footstepsEnabled': footsteps, 'moveAnimationId': self.anims['Walk'],
                'moveSpeedPxPerSec': move_speed_px or int(70 * self.p.walk_speed * 1.6), 'idleSpeedMul': idle_speed or self.p.idle_speed,
                'intro': {'kind': 'iris', 'durationMs': intro_ms}, 'outro': {'kind': 'iris', 'durationMs': outro_ms}}
        if self.music:
            n, f, v = self.music
            film['music'] = {'id': self.sid(n), 'name': n, 'volume': v, 'loop': True, 'file': f}
        for key in order:
            pl = dict(self.plans[key])
            pl['soundTracks'] = [tr for tr in pl['soundTracks'] if tr['clips']]
            for k in [k for k in pl if k.startswith('_')]: pl.pop(k)
            film['plans'].append(pl)
        t = intro_ms
        for pl in film['plans'][:-1]: t += pl['durationMs'] + pl['transitionToNext']['durationMs']
        film['posterMs'] = poster_ms if poster_ms is not None else intro_ms + film['plans'][0]['durationMs'] + 3000
        out = out or os.path.join(self.here, f'kit-{self.project[:8]}.json')
        json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
        total = intro_ms + sum(p['durationMs'] for p in film['plans']) + sum(p['transitionToNext']['durationMs'] for p in film['plans'][:-1]) + outro_ms
        # slots.md : les emplacements de sons à poser dans l'éditeur
        if self.slots:
            lines = [f"# {self.film} — emplacements de sons à poser (Nicolas)\n", '| Plan | Rôle | Début | Durée | Volume | Boucle | Note |', '|---|---|---|---|---|---|---|']
            for s in self.slots: lines.append(f"| {s['plan']} | {s['role']} | {s['startMs'] / 1000:.1f} s | {s['durationMs'] / 1000:.1f} s | {s['volume']} | {'oui' if s['loop'] else ''} | {s['note']} |")
            open(os.path.join(self.here, 'slots.md'), 'w').write('\n'.join(lines) + '\n')
        warns = self.check()
        print(f"kit écrit → {out} | {len(film['plans'])} plans | profil {self.p.name} | durée ≈ {total / 1000:.1f} s | {len(self.slots)} emplacements de sons (slots.md)")
        for x in warns: print('  ⚠', x)
        return out
