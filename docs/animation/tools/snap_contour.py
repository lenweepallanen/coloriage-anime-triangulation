"""Recale les points de CONTOUR de la triangulation (P0, ancres, subdivisions) pile sur le bord externe du trait (alpha ≥ 128
de l'image de référence), zone par zone, et marque les zones « ajustées pixel » (zonePixelAdjusted) : l'étape Maillage garde alors
ces points tels quels et recalcule les points internes (Delaunay) comme après un déplacement à la main dans l'admin.
Seuls les points proches du bord (≤ T px) bougent : les jonctions internes entre zones (loin du bord) restent en place.
Usage : python3 snap_contour.py <pid> <png> [T=12] [--apply]"""
import sys, json, numpy as np, cv2, auth
pid, png = sys.argv[1:3]; T=float(next((a.split('=')[1] for a in sys.argv[3:] if a.startswith('T=')), 12)); apply='--apply' in sys.argv
im=cv2.imread(png, cv2.IMREAD_UNCHANGED); a=(im[...,3]>=128).astype(np.uint8)
cs,_=cv2.findContours(a, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE); bnd=np.concatenate([c[:,0,:] for c in cs]).astype(np.float64)
d=auth.fs_get(f'projects/{pid}', mask=['projectTriangulation']); tri=auth.from_fs(d['fields']['projectTriangulation']); lab={z['id']:z['label'] for z in tri['zones']}
def snap(p):
    q=np.array([p['x'],p['y']]); dd=np.sqrt(((bnd-q)**2).sum(1)); k=int(dd.argmin())
    if dd[k] > T or dd[k] < 0.5: return p, 0.0
    return {'x': float(bnd[k,0]), 'y': float(bnd[k,1])}, float(dd[k])
report={}
for zid in tri['zonePoints']:
    mv=[]
    o,dd=snap(tri['zoneOrigins'][zid]); tri['zoneOrigins'][zid]=o; mv.append(dd)
    na=[]
    for p in tri['zoneAnchors'][zid]: q,dd=snap(p); na.append(q); mv.append(dd)
    tri['zoneAnchors'][zid]=na
    ns=[]
    for p in tri['zoneSubdivisionPoints'].get(zid, []): q,dd=snap(p); ns.append(q); mv.append(dd)
    tri['zoneSubdivisionPoints'][zid]=ns
    mv=np.array(mv); report[lab.get(zid,zid)]=f"{(mv>0).sum()}/{len(mv)} points recalés (déplacement médian {np.median(mv[mv>0]) if (mv>0).any() else 0:.1f} px, max {mv.max():.1f})"
for k,v in report.items(): print(f'{k:9s} : {v}')
if apply:
    fields={'projectTriangulation.zoneOrigins': tri['zoneOrigins'], 'projectTriangulation.zoneAnchors': tri['zoneAnchors'], 'projectTriangulation.zoneSubdivisionPoints': tri['zoneSubdivisionPoints'], 'projectTriangulation.zonePixelAdjusted': {zid: True for zid in tri['zonePoints']}}
    auth.fs_patch(f'projects/{pid}', fields); print('Firestore écrit (P0, ancres, subdivisions, zonePixelAdjusted)')
