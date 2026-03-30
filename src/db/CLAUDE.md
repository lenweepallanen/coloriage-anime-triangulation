# Base de données — Firebase (Firestore + Cloud Storage)

## Architecture

Séparation métadonnées / blobs :
- **Firestore** : documents légers (métadonnées, géométrie maillage, marqueurs, `animations[]`)
- **Cloud Storage** : fichiers lourds (images, vidéos, JSON keyframes/animation) **scopés par animation**

## Configuration

**Fichier :** `firebase.ts`
- Projet Firebase : `coloriage-anime-triangulation`
- Base Firestore nommée : `'coloriages'`
- Bucket Storage : `coloriage-anime-triangulation.firebasestorage.app`

## Collections Firestore

### `projects` (ProjectDoc)
```typescript
{
  name: string
  createdAt: number
  hasImage: boolean
  hasBackgroundVideo: boolean
  markers: MarkerCorners | null
  animations: AnimationDoc[]    // Remplace mesh/hasVideo au root
}
```

Chaque `AnimationDoc` :
```typescript
{
  id: string
  name: string
  type: 'rest' | 'oneshot'
  createdAt: number
  hasVideo: boolean
  mesh: MeshDoc | null          // Même structure qu'avant, mais par animation
}
```

### `scans` (ScanDoc)
```typescript
{
  projectId: string
  scannedAt: number
}
```

## Chemins Cloud Storage — scopés par animation

```
projects/{projectId}/originalImage                              → Blob image (niveau projet)
projects/{projectId}/backgroundVideo                            → Blob vidéo fond (niveau projet)
projects/{projectId}/animations/{animId}/video                  → Blob vidéo animation
projects/{projectId}/animations/{animId}/contourOriginKeyframes.json
projects/{projectId}/animations/{animId}/contourOriginFrames.json
projects/{projectId}/animations/{animId}/contourAnchorKeyframes.json
projects/{projectId}/animations/{animId}/contourAnchorFrames.json
projects/{projectId}/animations/{animId}/contourSubdivisionFrames.json
projects/{projectId}/animations/{animId}/contourCannyFrames.json
projects/{projectId}/animations/{animId}/anchorKeyframes.json
projects/{projectId}/animations/{animId}/anchorFrames.json
projects/{projectId}/animations/{animId}/videoFramesMesh.json
scans/{scanId}/scanImage                                        → Blob image rectifiée
```

## API (projectsStore.ts)

| Fonction | Description |
|----------|-------------|
| `createProject(name)` | Crée projet avec UUID + 1 animation rest par défaut |
| `getProject(id)` | Charge métadonnées + télécharge blobs + JSON Storage par animation |
| `getAllProjects()` | Liste projets (métadonnées seules, sans blobs) |
| `updateProject(project, uploadOnly?)` | Sauvegarde sélective avec hints scopés par animation |
| `deleteProject(id)` | Supprime projet + scans + tous les fichiers Storage par animation |

### Upload Hints

```typescript
UploadHint = 'image' | 'backgroundVideo' | { animationId: string; field: AnimationUploadField }

AnimationUploadField =
  | 'video' | 'contourOriginKeyframes' | 'contourOriginFrames'
  | 'contourAnchorKeyframes' | 'contourAnchorFrames'
  | 'contourSubdivisionFrames' | 'contourCannyFrames'
  | 'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'
```

`StepUploadHint` (utilisé par les step components) = string simple, scopé automatiquement par `AdminPage` qui ajoute l'`animationId`.

Sans hint, seules les métadonnées Firestore sont mises à jour.

### Migration legacy (projets v4 et antérieurs)

`isLegacyProjectDoc()` détecte les anciens formats (mesh/hasVideo au root, pas de `animations`). `fromLegacyDoc()` wrappe automatiquement les données existantes dans une animation rest. Les anciens chemins Storage sont lus tels quels ; à la prochaine sauvegarde, le nouveau format est écrit.

## API (scansStore.ts)

| Fonction | Description |
|----------|-------------|
| `createScan(projectId, scanImageBlob)` | Crée scan + upload image |
| `getScan(id)` | Charge scan + blob |
| `getScansByProject(projectId)` | Liste scans (métadonnées) |
| `updateScan(scan)` | Met à jour scan + image |
| `deleteScan(id)` | Supprime document + fichier |

## Helpers internes

- `uploadBlob(path, blob)` — Upload vers Cloud Storage
- `downloadBlob(path)` — Télécharge blob, retourne `null` si échec

## Sérialisation triangles

Les triangles `[number, number, number][]` sont convertis en `{ a, b, c }[]` pour Firestore (qui ne supporte pas les arrays imbriqués). La conversion se fait dans `updateProject` / `getProject`.

## Historique

Migration depuis IndexedDB (commit `d2bda23`). L'ancienne implémentation utilisait deux object stores (`'projects'`, `'scans'`) dans une base `'coloringAppDB'`.
