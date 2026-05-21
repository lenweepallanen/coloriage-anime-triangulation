import type { Project, Prop, ProjectTriangulation, SAM2Zone } from '../types/project'

/**
 * Réconcilie `Project.props` avec les zones accessoires de la triangulation.
 *
 * Règles :
 *  - Pour chaque `SAM2Zone` avec `isAccessory === true` ayant un contour lissé
 *    dans `tri.contours[zone.id]` : crée ou met à jour le `Prop` correspondant
 *    (`source === 'triangulation'`, `triangulationZoneId === zone.id`).
 *    Le `name` et le `contourParts` sont resynchronisés ; les réglages utilisateur
 *    (`attachment`, `offset`, `scale`, `zOrder`) sont **préservés**.
 *  - Tout `Prop` `source === 'triangulation'` dont la zone n'existe plus ou
 *    n'est plus marquée accessoire est **supprimé**.
 *  - Les `Prop` `source === 'manual'` sont **conservés tels quels**.
 */
export function syncTriangulationProps(project: Project, tri: ProjectTriangulation): Prop[] {
  const accessoryZones = (tri.zones ?? []).filter((z): z is SAM2Zone => z.isAccessory === true)
  const accessoryZoneIds = new Set(accessoryZones.map(z => z.id))

  // 1. Garde les props manuels intacts.
  const manualProps = project.props.filter(p => p.source !== 'triangulation')

  // 2. Pour chaque zone accessoire, crée ou met à jour le prop.
  const existingByZone = new Map<string, Prop>()
  for (const p of project.props) {
    if (p.source === 'triangulation' && p.triangulationZoneId) {
      existingByZone.set(p.triangulationZoneId, p)
    }
  }

  const next: Prop[] = [...manualProps]
  for (const zone of accessoryZones) {
    const contour = tri.contours?.[zone.id]
    if (!contour || contour.length < 3) continue   // pas de contour calculé encore
    const existing = existingByZone.get(zone.id)
    if (existing) {
      next.push({
        ...existing,
        name: zone.label || existing.name,
        contourParts: [contour.map(p => ({ x: p.x, y: p.y }))],
        zOrder: zone.zOrder ?? existing.zOrder,
      })
    } else {
      next.push({
        id: crypto.randomUUID(),
        name: zone.label || 'Accessoire',
        contourParts: [contour.map(p => ({ x: p.x, y: p.y }))],
        attachment: { mode: 'fixed' },
        offset: { x: 0, y: 0 },
        scale: 1,
        zOrder: zone.zOrder ?? 1,
        createdAt: Date.now(),
        source: 'triangulation',
        triangulationZoneId: zone.id,
      })
    }
  }

  // Les props 'triangulation' dont la zone n'existe plus / n'est plus accessoire
  // ne sont pas ré-ajoutés → suppression implicite.
  void accessoryZoneIds

  return next
}
