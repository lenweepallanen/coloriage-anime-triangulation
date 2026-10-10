"""Règle une animation Marche : python3 setup_marche.py <pid> <Trot|Galop> <points.json>
- pattes en marche = AVD/AVG/ARD/ARG ; zones non-pattes (TETE, CRINIERE…) = un seul os (le solveur interpole droit au-delà d'1 joint) ;
- genou de repos plié (18 % de la corde, angle ≈ 140°, comme les dinos) sinon l'IK ne plie rien ; hanche = point « hanche int » (dans le flanc) ;
- phases + paramètres trot / galop ; LBS power 4 / ARAP 5."""
import json, math, sys, auth
pid, name, pts_p = sys.argv[1:4]
pts=json.load(open(pts_p)); byname={p['name']:p['id'] for p in pts}; pos={p['name']:p['prompts'][0] for p in pts}
GAITS={'Trot':  dict(params=dict(speed=1.5, strideLength=170, footLift=130, bodySway=10, headSway=45, kneeForwardFront=False, kneeForwardBack=False, direction=-1, secondarySway=15, jumpHeight=0), phases={'AVD':0.0,'ARG':0.0,'AVG':0.5,'ARD':0.5}),
       'Galop': dict(params=dict(speed=2.0, strideLength=280, footLift=180, bodySway=18, headSway=70, kneeForwardFront=False, kneeForwardBack=False, direction=-1, secondarySway=25, jumpHeight=60), phases={'ARG':0.0,'ARD':0.15,'AVG':0.4,'AVD':0.55})}
LBS={'mode':'lbs-arap','weightPower':4,'weightEpsilon':1,'arapIterations':5,'weightSmoothIterations':0,'weightSmoothAlpha':0.5,'contourArapLambda':1,'contourArapIterations':2,'areaPostIterations':3,'areaPostStrength':0}
d=auth.fs_get(f'projects/{pid}', mask=['animations','projectTriangulation.maskWidth']); K=auth.from_fs(d['fields']['projectTriangulation'])['maskWidth']/960
img=lambda n: {'x': pos[n]['x']*K, 'y': pos[n]['y']*K}; ref=lambda n: {'pointIds':[byname[n]],'weights':[1]}
anims=auth.from_fs(d['fields']['animations']); a=[x for x in anims if x['name']==name][0]; m=a['mesh']; sk=m['marcheSkeleton']; rest=m['marcheLegRestPositions']
def first_last(leg):   # noms des points des extrémités de la chaîne héritée (refs à 1 point)
    byid={v:k for k,v in byname.items()}; return byid[leg['hip']['pointIds'][0]], byid[leg['foot']['pointIds'][0]]
for leg in sk['legs']:
    L=leg['name']
    if L not in ('AVD','AVG','ARD','ARG'):
        h,f=first_last(leg); leg['joints']=[]; rest[leg['id']]={'hip':img(h),'joints':[],'foot':img(f)}; print(f'{name} {L}: os unique {h} → {f}'); continue
    hip, knee, foot = img(f'{L} hanche int'), img(f'{L} genou'), img(f'{L} sabot')
    dx,dy=foot['x']-hip['x'],foot['y']-hip['y']; D=math.hypot(dx,dy); t=((knee['x']-hip['x'])*dx+(knee['y']-hip['y'])*dy)/(D*D)
    px,py=hip['x']+t*dx,hip['y']+t*dy; nx,ny=-dy/D,dx/D; side=-1 if L.startswith('AV') else 1
    if nx*side<0: nx,ny=-nx,-ny
    kb={'x':px+nx*0.18*D,'y':py+ny*0.18*D}
    leg['hip']=ref(f'{L} hanche int'); leg['joints']=[ref(f'{L} genou')]; leg['foot']=ref(f'{L} sabot'); rest[leg['id']]={'hip':hip,'joints':[kb],'foot':foot}
    print(f'{name} {L}: genou repos {round(kb["x"])},{round(kb["y"])}')
g=GAITS[name]; byl={l['name']:l['id'] for l in sk['legs']}
m['marcheGaitLegIds']=[byl[n] for n in ('AVD','AVG','ARD','ARG')]; m['marcheGaitLegsValidated']=True
m['marcheLegPhases']={byl[n]: ph for n,ph in g['phases'].items()}; m['walkParams']=g['params']; m['cotrackerLBSParams']=LBS; m['walkParamsValidated']=False; a['playbackMode']='loop'
auth.fs_patch(f'projects/{pid}', {'animations': anims}); print(name, 'réglé')
