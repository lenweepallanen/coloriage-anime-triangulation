"""Trot/Galop : avec 2 joints intermédiaires (genou + cheville) le solveur de marche interpole en ligne droite → genoux raides.
On ne garde que le genou (IK 2 os : côté du pli = côté du genou au repos, derrière la jambe comme un cheval)."""
import sys, auth
pid = '9f819082-bf93-4f2f-977e-018d312cf64b'
d = auth.fs_get(f'projects/{pid}', mask=['animations']); anims = auth.from_fs(d['fields']['animations'])
for a in anims:
    if a['type'] != 'marche': continue
    sk = a['mesh']['marcheSkeleton']; rest = a['mesh']['marcheLegRestPositions']
    for leg in sk['legs']:
        if leg['name'] not in ('AVD', 'AVG', 'ARD', 'ARG'): continue
        leg['joints'] = leg['joints'][:1]                       # genou seulement
        rest[leg['id']]['joints'] = rest[leg['id']]['joints'][:1]
        h, k, f = rest[leg['id']]['hip'], rest[leg['id']]['joints'][0], rest[leg['id']]['foot']
        cross = (k['x'] - h['x']) * (f['y'] - h['y']) - (k['y'] - h['y']) * (f['x'] - h['x'])
        print(a['name'], leg['name'], ': genou', {kk: round(v) for kk, v in k.items()}, '| côté du pli', 'arrière' if cross < 0 else 'avant', round(cross))
    a['mesh']['walkParamsValidated'] = False
auth.fs_patch(f'projects/{pid}', {'animations': anims}); print('Firestore écrit')
