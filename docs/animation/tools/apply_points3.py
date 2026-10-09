"""Pose points3 + skeleton3 dans Idle (tracking à refaire) et met à jour les hanches des Marche (refs + repos image)."""
import json, sys, auth
W=sys.argv[1]; pid='9f819082-bf93-4f2f-977e-018d312cf64b'
pts=json.load(open(f'{W}/licorne/points3.json')); sk=json.load(open(f'{W}/licorne/skeleton3.json')); byname={p['name']:p['id'] for p in pts}
pos={p['name']:p['prompts'][0] for p in pts}
d=auth.fs_get(f'projects/{pid}', mask=['animations','projectTriangulation.maskWidth','projectTriangulation.maskHeight'])
tri=auth.from_fs(d['fields']['projectTriangulation']); imgW,imgH=tri['maskWidth'],tri['maskHeight']; vw=vh=960
anims=auth.from_fs(d['fields']['animations'])
for a in anims:
    m=a['mesh']
    if a['name']=='Idle':
        m.update({'cotrackerPoints': pts, 'cotrackerSkeleton': sk, 'cotrackerTrackingValidated': False, 'cotrackerBonesValidated': False, 'cotrackerLBSValidated': False})
        print('Idle :', len(pts), 'points, squelette mis à jour (tracking à refaire)')
    elif a['type']=='marche':
        for leg in m['marcheSkeleton']['legs']:
            if leg['name'] in ('AVD','AVG','ARD','ARG'):
                n=f"{leg['name']} hanche int"; leg['hip']={'pointIds':[byname[n]],'weights':[1]}
                m['marcheLegRestPositions'][leg['id']]['hip']={'x': pos[n]['x']*imgW/vw, 'y': pos[n]['y']*imgH/vh}
        m['walkParamsValidated']=False; print(a['name'], ': hanches déplacées dans le flanc')
    elif a['name']=='Cabré':
        # points = mêmes positions frame 0 (même image source) → nouveaux points + squelette, tracking à refaire
        m.update({'cotrackerPoints': pts, 'cotrackerSkeleton': sk, 'cotrackerTrackingValidated': False, 'cotrackerBonesValidated': False, 'cotrackerLBSValidated': False})
        print('Cabré :', len(pts), 'points (tracking à refaire)')
auth.fs_patch(f'projects/{pid}', {'animations': anims}); print('Firestore écrit')
