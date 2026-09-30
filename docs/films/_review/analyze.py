import json, sys
name=sys.argv[1]
F=json.load(open(f'_review/{name}-final.json')); K=json.load(open(sys.argv[2]))
A=json.load(open(f'_review/{name}-anims.json'))
snames={s['id']:s['name'] for s in F.get('sounds',[])}
ksnames={s['id']:s['name'] for s in K.get('sounds',[])}
an=lambda i: A.get(i,i[:8])
def clips(pl):
    out=[]
    for ti,tr in enumerate(pl.get('soundTracks',[])):
        for c in tr.get('clips',[]): out.append((ti,c))
    return out
print(f"===== {name.upper()} =====")
print('réglages :', {k:F.get(k) for k in ('footstepsEnabled','footstepsVolume','masterVolume','moveSpeedPxPerSec','idleSpeedMul','posterMs')}, '| intro', F.get('intro'), '| outro', F.get('outro'))
print('musique :', F.get('music') and {k:F['music'].get(k) for k in ('name','volume')}, '| kit :', K.get('music') and {k:K['music'].get(k) for k in ('name','volume')})
print('personnage :', F.get('character'))
kp={p['id']:p for p in K['plans']}
for i,pl in enumerate(F['plans']):
    k=kp.get(pl['id'])
    print(f"\n--- plan {i+1} « {pl.get('name')} » {pl['durationMs']} ms (kit {k['durationMs'] if k else 'NOUVEAU'}) | transition {pl.get('transitionToNext')} | cameraX {pl.get('cameraX')}")
    for w in pl.get('waypoints',[]):
        kw=next((x for x in (k or {}).get('waypoints',[]) if x['id']==w['id']),None)
        print('  WP', {kk:w.get(kk) for kk in ('x','y','scale','facing')}, '| kit', kw and {kk:kw.get(kk) for kk in ('x','y','scale','facing')})
    for m in pl.get('motion',[]):
        print('  MOTION', m['kind'], m['startMs'], '+', m['durationMs'], 'anim', an(m.get('animationId','')) if m.get('animationId') else '', 'x', m.get('animSpeedMul'), 'easing', m.get('easing'), 'from', m.get('from'), 'to', m.get('to'), 'cps', len(m.get('controlPoints') or []))
    for a in pl.get('anim',[]):
        print('  ANIM', a['startMs'], '+', a['durationMs'], an(a['animationId']), 'x', a.get('speedMul'), a.get('fillMode'))
    for c in pl.get('camera',[]) or []:
        print('  CAM', c['kind'], c['startMs'], '+', c['durationMs'], {kk:c.get(kk) for kk in ('amplitude','frequencyHz','rect','zoomInMs','holdMs','zoomOutMs','maxZoom','anchor') if c.get(kk) is not None})
    for ti,c in clips(pl):
        print(f"  SND[{ti}]", c['startMs'], '+', c['durationMs'], snames.get(c['soundId'],c['soundId'][:8]), 'vol', c.get('volume'), 'off', c.get('offsetMs'), 'rate', c.get('rate'), 'loop' if c.get('loop') else '', 'PARLÉ' if c.get('isSpoken') else '', 'fade', c.get('fadeInMs'), c.get('fadeOutMs'), 'anchor' if c.get('anchor') else '')
for ti,tr in enumerate(F.get('globalSoundTracks') or []):
    for c in tr.get('clips',[]): print(f"  GLOBAL[{ti}]", c['startMs'], '+', c['durationMs'], snames.get(c['soundId'],c['soundId'][:8]), 'vol', c.get('volume'), 'loop' if c.get('loop') else '', 'fade', c.get('fadeInMs'), c.get('fadeOutMs'))
print('\nsons ajoutés par Nicolas :', [n for i,n in snames.items() if i not in ksnames])
print('sons retirés :', [n for i,n in ksnames.items() if i not in snames])
