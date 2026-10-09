"""Trot/Galop : la chaîne TETE à 10 joints est écrasée par le solveur de marche (joints intermédiaires ≥ 2 → interpolation
sur la corde hanche→pied, très courte ici). On la remplace par un os unique cou base → museau (zone rigide qui suit le corps),
avec ses positions de repos (frame 0 du tracking d'Idle, coords IMAGE)."""
import json, sys, auth
W = sys.argv[1]; pid = '9f819082-bf93-4f2f-977e-018d312cf64b'
pts = json.load(open(f'{W}/licorne/points2.json')); byname = {p['name']: p['id'] for p in pts}
fr = json.load(open(f'{W}/licorne/cotrackerFrames.json'))
d = auth.fs_get(f'projects/{pid}', mask=['animations', 'projectTriangulation.maskWidth', 'projectTriangulation.maskHeight'])
tri = auth.from_fs(d['fields']['projectTriangulation']); imgW, imgH = tri['maskWidth'], tri['maskHeight']
anims = auth.from_fs(d['fields']['animations'])
idle = [a for a in anims if a['name'] == 'Idle'][0]; vw, vh = idle['mesh']['cotrackerVideoWidth'], idle['mesh']['cotrackerVideoHeight']
def img(name): p = fr[byname[name]][0]; return {'x': p['x'] * imgW / vw, 'y': p['y'] * imgH / vh}
ref = lambda name: {'pointIds': [byname[name]], 'weights': [1]}
for a in anims:
    if a['type'] != 'marche': continue
    sk = a['mesh']['marcheSkeleton']
    for leg in sk['legs']:
        if leg['name'] != 'TETE': continue
        leg['hip'] = ref('cou base'); leg['joints'] = []; leg['foot'] = ref('museau')
        a['mesh']['marcheLegRestPositions'][leg['id']] = {'hip': img('cou base'), 'joints': [], 'foot': img('museau')}
        print(a['name'], ': TETE →', 'cou base', a['mesh']['marcheLegRestPositions'][leg['id']]['hip'], '→ museau', a['mesh']['marcheLegRestPositions'][leg['id']]['foot'])
    a['mesh']['walkParamsValidated'] = False
auth.fs_patch(f'projects/{pid}', {'animations': anims}); print('Firestore écrit (image', imgW, 'x', imgH, '; vidéo', vw, 'x', vh, ')')
