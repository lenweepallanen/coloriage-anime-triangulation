"""Trot/Galop v4 (après écrasement par un onglet admin périmé) : hanches dans le flanc, 1 joint par patte avec GENOU PLIÉ AU REPOS
(comme les dinos : angle 110-150°, ratio hanche→pied / chaîne ≈ 0,9 ; une patte droite ne peut pas plier en IK), paramètres de marche
proportionnels aux dinos (image 2048 vs 1254), LBS alignés sur les réglages de Nicolas (power 4, ARAP 5)."""
import json, math, sys, auth
W=sys.argv[1]; pid='9f819082-bf93-4f2f-977e-018d312cf64b'
pts=json.load(open(f'{W}/licorne/points3.json')); byname={p['name']:p['id'] for p in pts}; pos={p['name']:p['prompts'][0] for p in pts}
d=auth.fs_get(f'projects/{pid}', mask=['animations','projectTriangulation.maskWidth','projectTriangulation.maskHeight'])
tri=auth.from_fs(d['fields']['projectTriangulation']); K=tri['maskWidth']/960
img=lambda n: {'x': pos[n]['x']*K, 'y': pos[n]['y']*K}
PARAMS={'Trot':  dict(speed=1.5, strideLength=170, footLift=130, bodySway=10, headSway=45, kneeForwardFront=False, kneeForwardBack=False, direction=-1, secondarySway=15, jumpHeight=0),
        'Galop': dict(speed=2.0, strideLength=280, footLift=180, bodySway=18, headSway=70, kneeForwardFront=False, kneeForwardBack=False, direction=-1, secondarySway=25, jumpHeight=60)}
LBS={'mode':'lbs-arap','weightPower':4,'weightEpsilon':1,'arapIterations':5,'weightSmoothIterations':0,'weightSmoothAlpha':0.5,'contourArapLambda':1,'contourArapIterations':2,'areaPostIterations':3,'areaPostStrength':0}
anims=auth.from_fs(d['fields']['animations'])
for a in anims:
    if a['type']!='marche': continue
    m=a['mesh']; sk=m['marcheSkeleton']; rest=m['marcheLegRestPositions']
    for leg in sk['legs']:
        L=leg['name']
        if L=='TETE':
            leg['hip']={'pointIds':[byname['cou base']],'weights':[1]}; leg['joints']=[]; leg['foot']={'pointIds':[byname['museau']],'weights':[1]}
            rest[leg['id']]={'hip':img('cou base'),'joints':[],'foot':img('museau')}; continue
        hip, knee, foot = img(f'{L} hanche int'), img(f'{L} genou'), img(f'{L} sabot')
        # genou plié au repos : projeté sur la corde hanche→sabot puis décalé perpendiculairement de 18 % de la corde,
        # vers la TÊTE (−x) pour les antérieurs (carpe), vers la QUEUE (+x) pour les postérieurs (jarret)
        dx,dy=foot['x']-hip['x'],foot['y']-hip['y']; D=math.hypot(dx,dy); t=((knee['x']-hip['x'])*dx+(knee['y']-hip['y'])*dy)/(D*D)
        px,py=hip['x']+t*dx,hip['y']+t*dy; nx,ny=-dy/D,dx/D   # normale
        side = -1 if L.startswith('AV') else 1                 # signe souhaité sur x
        if nx*side<0: nx,ny=-nx,-ny
        kb={'x':px+nx*0.18*D,'y':py+ny*0.18*D}
        leg['hip']={'pointIds':[byname[f'{L} hanche int']],'weights':[1]}; leg['joints']=[{'pointIds':[byname[f'{L} genou']],'weights':[1]}]; leg['foot']={'pointIds':[byname[f'{L} sabot']],'weights':[1]}
        rest[leg['id']]={'hip':hip,'joints':[kb],'foot':foot}
        chain=math.hypot(kb['x']-hip['x'],kb['y']-hip['y'])+math.hypot(foot['x']-kb['x'],foot['y']-kb['y'])
        ang=math.degrees(math.acos(max(-1,min(1,((hip['x']-kb['x'])*(foot['x']-kb['x'])+(hip['y']-kb['y'])*(foot['y']-kb['y']))/(math.hypot(hip['x']-kb['x'],hip['y']-kb['y'])*math.hypot(foot['x']-kb['x'],foot['y']-kb['y']))))))
        print(f"{a['name']} {L}: genou repos {round(kb['x'])},{round(kb['y'])} (décalé {'tête' if side<0 else 'queue'}) angle {ang:.0f}° ratio {D/chain:.2f}")
    m['marcheGaitLegIds']=[l['id'] for l in sk['legs'] if l['name']!='TETE']
    m['walkParams']=PARAMS[a['name']]; m['cotrackerLBSParams']=LBS; m['walkParamsValidated']=False
auth.fs_patch(f'projects/{pid}', {'animations': anims}); print('Firestore écrit')
