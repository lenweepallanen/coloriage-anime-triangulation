/**
 * Draws L-shaped markers at the 4 corners of the drawing area.
 * Each marker is oriented to point inward (toward the center).
 */

export interface MarkerConfig {
  size: number      // size in pixels of the L marker
  thickness: number // thickness of the L arms
}

const DEFAULT_CONFIG: MarkerConfig = { size: 40, thickness: 10 }

type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

/**
 * Draw an L-shaped marker on a canvas 2D context.
 * The marker points inward based on the corner position.
 */
export function drawLMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  corner: Corner,
  config: MarkerConfig = DEFAULT_CONFIG
) {
  const { size, thickness } = config
  ctx.fillStyle = '#000000'

  switch (corner) {
    case 'topLeft':
      // L pointing down-right
      ctx.fillRect(x, y, size, thickness)         // horizontal arm
      ctx.fillRect(x, y, thickness, size)          // vertical arm
      break
    case 'topRight':
      // L pointing down-left
      ctx.fillRect(x - size, y, size, thickness)   // horizontal arm
      ctx.fillRect(x - thickness, y, thickness, size) // vertical arm
      break
    case 'bottomLeft':
      // L pointing up-right
      ctx.fillRect(x, y - thickness, size, thickness)  // horizontal arm
      ctx.fillRect(x, y - size, thickness, size)        // vertical arm
      break
    case 'bottomRight':
      // L pointing up-left
      ctx.fillRect(x - size, y - thickness, size, thickness) // horizontal arm
      ctx.fillRect(x - thickness, y - size, thickness, size) // vertical arm
      break
  }
}

/**
 * Draw all 4 L markers on a canvas for preview purposes.
 */
export function drawAllMarkers(
  ctx: CanvasRenderingContext2D,
  corners: { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomLeft: { x: number; y: number }; bottomRight: { x: number; y: number } },
  config: MarkerConfig = DEFAULT_CONFIG
) {
  const entries: [Corner, { x: number; y: number }][] = [
    ['topLeft', corners.topLeft],
    ['topRight', corners.topRight],
    ['bottomLeft', corners.bottomLeft],
    ['bottomRight', corners.bottomRight],
  ]
  for (const [corner, pos] of entries) {
    drawLMarker(ctx, pos.x, pos.y, corner, config)
  }
}
