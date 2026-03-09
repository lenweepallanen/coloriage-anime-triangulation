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
    closeContour,
    addInternalPoint,
    movePoint,
    deletePoint,
    clearAll,
  }
}
