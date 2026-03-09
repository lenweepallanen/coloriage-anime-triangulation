import { useState, useMemo, useCallback } from 'react'
import Delaunator from 'delaunator'
import type { Point2D } from '../../types/project'
import { pointInPolygon, triangleCentroid } from '../../utils/geometry'

export interface TriangulationState {
  contourPoints: Point2D[]
  internalPoints: Point2D[]
  triangles: [number, number, number][]
  contourClosed: boolean
}

export function useTriangulation(initial?: {
  contourPoints: Point2D[]
  internalPoints: Point2D[]
  triangles: [number, number, number][]
}) {
  const [contourPoints, setContourPoints] = useState<Point2D[]>(
    initial?.contourPoints ?? []
  )
  const [internalPoints, setInternalPoints] = useState<Point2D[]>(
    initial?.internalPoints ?? []
  )
  const [contourClosed, setContourClosed] = useState(
    initial ? initial.contourPoints.length >= 3 : false
  )

  const allPoints = useMemo(
    () => [...contourPoints, ...internalPoints],
    [contourPoints, internalPoints]
  )

  const triangles = useMemo(() => {
    if (!contourClosed || contourPoints.length < 3) return []
    if (allPoints.length < 3) return []

    const coords = new Float64Array(allPoints.length * 2)
    allPoints.forEach((p, i) => {
      coords[i * 2] = p.x
      coords[i * 2 + 1] = p.y
    })

    try {
      const delaunay = new Delaunator(coords)
      const result: [number, number, number][] = []

      for (let i = 0; i < delaunay.triangles.length; i += 3) {
        const a = delaunay.triangles[i]
        const b = delaunay.triangles[i + 1]
        const c = delaunay.triangles[i + 2]

        const centroid = triangleCentroid(allPoints[a], allPoints[b], allPoints[c])
        if (pointInPolygon(centroid, contourPoints)) {
          result.push([a, b, c])
        }
      }

      return result
    } catch {
      return []
    }
  }, [allPoints, contourPoints, contourClosed])

  const addContourPoint = useCallback((p: Point2D) => {
    setContourPoints(prev => [...prev, p])
  }, [])

  const insertContourPoint = useCallback((afterIndex: number, p: Point2D) => {
    setContourPoints(prev => {
      const next = [...prev]
      next.splice(afterIndex + 1, 0, p)
      return next
    })
  }, [])

  const closeContour = useCallback(() => {
    setContourClosed(true)
  }, [])

  const addInternalPoint = useCallback((p: Point2D) => {
    setInternalPoints(prev => [...prev, p])
  }, [])

  const movePoint = useCallback(
    (type: 'contour' | 'internal', index: number, p: Point2D) => {
      if (type === 'contour') {
        setContourPoints(prev => {
          const next = [...prev]
          next[index] = p
          return next
        })
      } else {
        setInternalPoints(prev => {
          const next = [...prev]
          next[index] = p
          return next
        })
      }
    },
    []
  )

  const deletePoint = useCallback(
    (type: 'contour' | 'internal', index: number) => {
      if (type === 'contour') {
        setContourPoints(prev => prev.filter((_, i) => i !== index))
        if (contourPoints.length <= 3) setContourClosed(false)
      } else {
        setInternalPoints(prev => prev.filter((_, i) => i !== index))
      }
    },
    [contourPoints.length]
  )

  const loadAutoMesh = useCallback((contour: Point2D[], internal: Point2D[]) => {
    setContourPoints(contour)
    setInternalPoints(internal)
    setContourClosed(true)
  }, [])

  const resampleContour = useCallback((targetCount: number) => {
    setContourPoints(prev => {
      if (prev.length < 3 || targetCount < 3) return prev

      // Compute cumulative arc lengths
      const n = prev.length
      const cumLen = [0]
      for (let i = 1; i <= n; i++) {
        const a = prev[i - 1]
        const b = prev[i % n]
        const dx = b.x - a.x
        const dy = b.y - a.y
        cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy))
      }
      const totalLen = cumLen[n]
      if (totalLen === 0) return prev

      // Place targetCount points at equal arc-length intervals
      const step = totalLen / targetCount
      const result: Point2D[] = []
      let segIdx = 0

      for (let i = 0; i < targetCount; i++) {
        const targetDist = i * step
        while (segIdx < n - 1 && cumLen[segIdx + 1] < targetDist) {
          segIdx++
        }
        const segStart = cumLen[segIdx]
        const segEnd = cumLen[segIdx + 1]
        const t = segEnd > segStart ? (targetDist - segStart) / (segEnd - segStart) : 0
        const a = prev[segIdx]
        const b = prev[(segIdx + 1) % n]
        result.push({
          x: a.x + t * (b.x - a.x),
          y: a.y + t * (b.y - a.y),
        })
      }

      return result
    })
  }, [])

  const clearAll = useCallback(() => {
    setContourPoints([])
    setInternalPoints([])
    setContourClosed(false)
  }, [])

  return {
    contourPoints,
    internalPoints,
    allPoints,
    triangles,
    contourClosed,
    addContourPoint,
    insertContourPoint,
    closeContour,
    addInternalPoint,
    movePoint,
    deletePoint,
    resampleContour,
    loadAutoMesh,
    clearAll,
  }
}
