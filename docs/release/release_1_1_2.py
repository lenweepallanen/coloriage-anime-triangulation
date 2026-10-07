#!/usr/bin/env python3
"""Release 1.1.2 (build 7 / versionCode 7) — écran de validation compact (boutons visibles sur petit écran) + scroll libre.
iOS : embarque aussi la 1.1 (comptage de scans anonyme, correctif ouverture des coloriages) jamais publiée sur l'App Store.
  python3 docs/release/release_1_1_2.py asc    # attend le build 7, renomme la version 1.1.0 (DEVELOPER_REJECTED) en 1.1.2, notes, attache, soumet
  python3 docs/release/release_1_1_2.py play   # envoie l'AAB et déploie en production (100 %)
"""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
VERSION, BUILD = '1.1.2', '7'
NOTES_IOS = {'en-US': 'Confirm / Start over buttons now always visible after a scan, including on small screens. Anonymous usage counts (no personal data), footstep sounds in films played in full, and small fixes.',
             'fr-FR': "Les boutons Valider / Recommencer sont toujours visibles après un scan, même sur petit écran. Comptages d'usage anonymes (aucune donnée personnelle), bruits de pas des films joués en entier, petites corrections."}
NOTES_PLAY = {'en-US': 'Confirm / Start over buttons now always visible after a scan, including on small screens.',
              'fr-FR': "Les boutons Valider / Recommencer sont toujours visibles après un scan, même sur petit écran."}

def asc():
    import asc_api as A
    app, _ = A.app_id()
    build = None
    for _ in range(60):
        d = A.get('/v1/builds', **{'filter[app]': app, 'filter[version]': BUILD, 'fields[builds]': 'version,processingState', 'limit': 5})
        for b in d['data']:
            if b['attributes']['version'] == BUILD: build = b
        if build and build['attributes']['processingState'] == 'VALID': break
        print('build', BUILD, 'en traitement…' if build else 'pas encore visible…', flush=True); time.sleep(60)
    if not build or build['attributes']['processingState'] != 'VALID': sys.exit('build %s non traité' % BUILD)
    d = A.get('/v1/apps/' + app + '/appStoreVersions', **{'filter[appStoreState]': 'PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,WAITING_FOR_REVIEW,READY_FOR_REVIEW', 'filter[platform]': 'IOS', 'fields[appStoreVersions]': 'versionString,appStoreState'})
    cands = [v for v in d['data'] if v['attributes']['versionString'].startswith('1.1.')]
    if not cands: sys.exit('aucune version 1.1.x modifiable : ' + json.dumps(d['data'])[:300])
    ver = cands[0]; vid = ver['id']; print('version', ver['attributes'])
    if ver['attributes']['versionString'] != VERSION:
        s, r = A.request('PATCH', f'/v1/appStoreVersions/{vid}', body={'data': {'type': 'appStoreVersions', 'id': vid, 'attributes': {'versionString': VERSION}}})
        print('renommée en', VERSION, '→', s, '' if s == 200 else json.dumps(r)[:300])
    d = A.get(f'/v1/appStoreVersions/{vid}/appStoreVersionLocalizations', **{'fields[appStoreVersionLocalizations]': 'locale'})
    for l in d['data']:
        if l['attributes']['locale'] in NOTES_IOS:
            s, r = A.request('PATCH', f"/v1/appStoreVersionLocalizations/{l['id']}", body={'data': {'type': 'appStoreVersionLocalizations', 'id': l['id'], 'attributes': {'whatsNew': NOTES_IOS[l['attributes']['locale']]}}})
            print('notes', l['attributes']['locale'], '→', s)
    s, r = A.request('PATCH', f'/v1/appStoreVersions/{vid}/relationships/build', body={'data': {'type': 'builds', 'id': build['id']}})
    print('build', BUILD, 'attaché →', s, '' if s == 204 else json.dumps(r)[:300])
    s, r = A.request('POST', '/v1/reviewSubmissions', body={'data': {'type': 'reviewSubmissions', 'attributes': {'platform': 'IOS'}, 'relationships': {'app': {'data': {'type': 'apps', 'id': app}}}}})
    if s != 201: sys.exit('reviewSubmission → %s %s' % (s, json.dumps(r)[:400]))
    sid = r['data']['id']
    s, r = A.request('POST', '/v1/reviewSubmissionItems', body={'data': {'type': 'reviewSubmissionItems', 'relationships': {'reviewSubmission': {'data': {'type': 'reviewSubmissions', 'id': sid}}, 'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': vid}}}}})
    print('item →', s, '' if s == 201 else json.dumps(r)[:400])
    s, r = A.request('PATCH', f'/v1/reviewSubmissions/{sid}', body={'data': {'type': 'reviewSubmissions', 'id': sid, 'attributes': {'submitted': True}}})
    print('soumission →', s, r.get('data', {}).get('attributes', {}).get('state') if s == 200 else json.dumps(r)[:400])

def play():
    import play_api as P, urllib.request
    aab = os.path.expanduser('~/Downloads/picopop-1.1.2-versionCode7.aab')
    s, e = P.request('POST', '/edits', body={}); eid = e['id']; env = P.load_env()
    url = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{env['PLAY_PACKAGE']}/edits/{eid}/bundles?uploadType=media"
    req = urllib.request.Request(url, data=open(aab, 'rb').read(), method='POST', headers={'Authorization': 'Bearer ' + P.token(), 'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=900) as r: b = json.loads(r.read()); print('bundle envoyé : versionCode', b.get('versionCode'))
    s, r = P.request('PUT', f'/edits/{eid}/tracks/production', body={'track': 'production', 'releases': [{'name': VERSION, 'versionCodes': [str(b['versionCode'])], 'status': 'completed', 'releaseNotes': [{'language': k, 'text': v} for k, v in NOTES_PLAY.items()]}]})
    print('production →', s, '' if s == 200 else json.dumps(r)[:400])
    s, r = P.request('POST', f'/edits/{eid}:commit'); print('commit →', s, '' if s == 200 else json.dumps(r)[:400])

if __name__ == '__main__':
    {'asc': asc, 'play': play}[sys.argv[1]]()
