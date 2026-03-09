/**
 * Loads opencv.js dynamically from public/ folder.
 * OpenCV.js WASM can't be bundled by Vite, so we load it via script tag.
 * Uses @techstark/opencv-js which exposes a factory function.
 */

let cvPromise: Promise<any> | null = null

export function loadOpenCV(): Promise<any> {
  if (cvPromise) return cvPromise

  cvPromise = new Promise((resolve, reject) => {
    // Check if already loaded and initialized
    const existing = (window as any).cv
    if (existing && existing.Mat) {
      resolve(existing)
      return
    }

    const script = document.createElement('script')
    script.src = '/opencv.js'
    script.async = true

    script.onload = () => {
      const cv = (window as any).cv
      if (!cv) {
        reject(new Error('opencv.js loaded but cv not found on window'))
        return
      }

      // @techstark/opencv-js exposes cv as a factory or as a ready object
      if (typeof cv === 'function') {
        // Factory pattern: call it to get the initialized module
        cv().then((ready: any) => {
          (window as any).cv = ready
          resolve(ready)
        }).catch(reject)
      } else if (cv.onRuntimeInitialized !== undefined && !cv.calledRun) {
        // Emscripten pattern: wait for runtime init
        const origCallback = cv.onRuntimeInitialized
        cv.onRuntimeInitialized = () => {
          if (typeof origCallback === 'function') origCallback()
          resolve(cv)
        }
      } else if (cv.Mat) {
        // Already initialized
        resolve(cv)
      } else {
        // Wait a bit for async init
        const check = setInterval(() => {
          if ((window as any).cv && (window as any).cv.Mat) {
            clearInterval(check)
            resolve((window as any).cv)
          }
        }, 100)
        setTimeout(() => {
          clearInterval(check)
          if ((window as any).cv && (window as any).cv.Mat) {
            resolve((window as any).cv)
          } else {
            reject(new Error('opencv.js initialization timeout'))
          }
        }, 30000)
      }
    }

    script.onerror = () => {
      cvPromise = null
      reject(new Error('Failed to load opencv.js. Make sure opencv.js is in the public/ folder.'))
    }

    document.head.appendChild(script)
  })

  return cvPromise
}
