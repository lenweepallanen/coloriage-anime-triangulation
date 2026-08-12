import Foundation
import Capacitor
import AVFoundation
import UIKit

/**
 * Plugin local : colle la vidéo outro PicoPop (bundlée dans public/outro-picopop.mp4)
 * à la fin d'une vidéo de film enregistrée, via AVFoundation (encodage matériel).
 * Peut aussi PRÉFIXER un court plan fixe (vignette) au tout début : c'est cette
 * première image que iMessage/WhatsApp affichent en aperçu du partage.
 *
 * JS : VideoConcat.appendOutro({ inputPath, outputPath, posterMs? }) → { uri }
 *  - inputPath  : chemin fichier absolu (file://... ou chemin brut) de la vidéo film
 *  - outputPath : chemin fichier absolu du .mp4 à produire (écrasé s'il existe)
 *  - posterMs   : (optionnel) instant (ms) dont l'image sert de vignette préfixée.
 *                 Absent/échec → aucun préfixe (comportement historique).
 *
 * L'outro (1920×1080) est mis à l'échelle « aspect fit » dans la résolution du film.
 */
@objc(VideoConcatPlugin)
public class VideoConcatPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoConcatPlugin"
    public let jsName = "VideoConcat"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "appendOutro", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTorch", returnType: CAPPluginReturnPromise)
    ]

    /**
     * Allume/éteint la lampe torche (flash) de la caméra arrière via AVFoundation.
     * L'API web `MediaStreamTrack.applyConstraints({torch})` ne fonctionne pas sur
     * iOS (WKWebView) — on pilote donc le matériel côté natif.
     * JS : VideoConcat.setTorch({ on: true|false }) → { available: Bool, on: Bool }
     */
    @objc func setTorch(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else {
            call.resolve(["available": false, "on": false])
            return
        }
        do {
            try device.lockForConfiguration()
            if on {
                try device.setTorchModeOn(level: 1.0)
            } else {
                device.torchMode = .off
            }
            device.unlockForConfiguration()
            call.resolve(["available": true, "on": on])
        } catch {
            call.reject("Torch error : \(error.localizedDescription)")
        }
    }

    private func fileURL(_ raw: String) -> URL {
        if raw.hasPrefix("file://"), let u = URL(string: raw) { return u }
        return URL(fileURLWithPath: raw)
    }

    @objc func appendOutro(_ call: CAPPluginCall) {
        guard let inputPath = call.getString("inputPath"),
              let outputPath = call.getString("outputPath") else {
            call.reject("inputPath et outputPath requis")
            return
        }
        guard let outroURL = Bundle.main.url(forResource: "outro-picopop", withExtension: "mp4", subdirectory: "public") else {
            call.reject("outro-picopop.mp4 introuvable dans le bundle")
            return
        }
        let filmURL = fileURL(inputPath)
        let outURL = fileURL(outputPath)
        // posterMs : Double optionnel (nil si absent → aucun préfixe vignette).
        let posterMs: Double? = call.getDouble("posterMs")

        DispatchQueue.global(qos: .userInitiated).async {
            self.concat(filmURL: filmURL, outroURL: outroURL, outURL: outURL, posterMs: posterMs) { result in
                switch result {
                case .success(let uri):
                    call.resolve(["uri": uri])
                case .failure(let err):
                    call.reject("Concat impossible : \(err.localizedDescription)")
                }
            }
        }
    }

    /**
     * Écrit un court clip .mp4 (durée `seconds`) d'une image FIXE `image` à la
     * taille `size`, via AVAssetWriter. Utilisé pour préfixer la vignette : cette
     * image devient la 1ʳᵉ frame du fichier partagé (aperçu des messageries).
     * Retourne nil en cas d'échec (le partage se fait alors sans préfixe).
     */
    private func makeStillClip(image: CGImage, size: CGSize, seconds: Double) -> URL? {
        let w = Int(size.width), h = Int(size.height)
        guard w > 1, h > 1 else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("picopop-still-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: url)
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return nil }
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        // Format BGRA : DOIT correspondre à l'ordre d'octets du CGContext plus bas
        // (premultipliedFirst + byteOrder32Little = BGRA en mémoire). Avec 32ARGB,
        // rouge et bleu étaient inversés → toute la vignette virait au violet.
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferWidthKey as String: w,
            kCVPixelBufferHeightKey as String: h,
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attrs)
        guard writer.canAdd(input) else { return nil }
        writer.add(input)
        guard writer.startWriting() else { return nil }
        writer.startSession(atSourceTime: .zero)

        guard let pool = adaptor.pixelBufferPool else { writer.cancelWriting(); return nil }
        var pxOut: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pxOut) == kCVReturnSuccess,
              let px = pxOut else { writer.cancelWriting(); return nil }
        CVPixelBufferLockBaseAddress(px, [])
        if let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(px),
            width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(px),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) {
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        CVPixelBufferUnlockBaseAddress(px, [])

        let fps: Int32 = 30
        let frames = max(1, Int((seconds * Double(fps)).rounded()))
        for i in 0..<frames {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
            adaptor.append(px, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
        }
        input.markAsFinished()
        let sem = DispatchSemaphore(value: 0)
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: fps))
        writer.finishWriting { sem.signal() }
        sem.wait()
        return writer.status == .completed ? url : nil
    }

    /** CGImage de la vidéo `asset` à l'instant `ms` (image redressée). nil si échec. */
    private func stillImage(from asset: AVAsset, ms: Double) -> CGImage? {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 30)
        gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
        let dur = CMTimeGetSeconds(asset.duration)
        let clamped = max(0, min(ms / 1000.0, max(0, dur - 0.05)))
        let time = CMTime(seconds: clamped, preferredTimescale: 600)
        return try? gen.copyCGImage(at: time, actualTime: nil)
    }

    private enum ConcatError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            if case .message(let m) = self { return m }
            return nil
        }
    }

    private func concat(filmURL: URL, outroURL: URL, outURL: URL, posterMs: Double?, completion: @escaping (Result<String, Error>) -> Void) {
        let film = AVURLAsset(url: filmURL)
        let outro = AVURLAsset(url: outroURL)

        guard let filmVideo = film.tracks(withMediaType: .video).first else {
            completion(.failure(ConcatError.message("pas de piste vidéo dans le film")))
            return
        }
        guard let outroVideo = outro.tracks(withMediaType: .video).first else {
            completion(.failure(ConcatError.message("pas de piste vidéo dans l'outro")))
            return
        }

        // Taille de rendu = taille du film (dimensions paires exigées par H.264).
        let filmSize = filmVideo.naturalSize.applying(filmVideo.preferredTransform)
        let renderW = floor(abs(filmSize.width) / 2) * 2
        let renderH = floor(abs(filmSize.height) / 2) * 2
        let renderSize = CGSize(width: max(renderW, 2), height: max(renderH, 2))

        // VIGNETTE : court plan fixe (0,5 s) préfixé → 1ʳᵉ frame du fichier partagé
        // = l'image choisie (aperçu iMessage/WhatsApp). Best-effort : tout échec
        // ici retombe simplement sur [film][outro] (still = nil).
        let stillDuration = 0.5
        var stillAsset: AVURLAsset?
        var stillVideoTrack: AVAssetTrack?
        if let ms = posterMs, ms >= 0,
           let cg = stillImage(from: film, ms: ms),
           let stillURL = makeStillClip(image: cg, size: renderSize, seconds: stillDuration),
           let sAsset = Optional(AVURLAsset(url: stillURL)),
           let sTrack = sAsset.tracks(withMediaType: .video).first {
            stillAsset = sAsset
            stillVideoTrack = sTrack
        }

        let composition = AVMutableComposition()
        guard let compVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            completion(.failure(ConcatError.message("création piste vidéo impossible")))
            return
        }
        let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        let filmRange = CMTimeRange(start: .zero, duration: film.duration)
        let outroRange = CMTimeRange(start: .zero, duration: outro.duration)

        // Curseur temporel : le plan fixe (s'il existe) décale film et outro.
        var cursor = CMTime.zero
        var stillRange: CMTimeRange?
        do {
            if let sTrack = stillVideoTrack, let sAsset = stillAsset {
                let r = CMTimeRange(start: .zero, duration: sAsset.duration)
                try compVideo.insertTimeRange(r, of: sTrack, at: cursor)
                stillRange = CMTimeRange(start: cursor, duration: sAsset.duration)
                cursor = cursor + sAsset.duration
            }
            let filmStart = cursor
            try compVideo.insertTimeRange(filmRange, of: filmVideo, at: filmStart)
            cursor = cursor + film.duration
            let outroStart = cursor
            try compVideo.insertTimeRange(outroRange, of: outroVideo, at: outroStart)
            if let audioTrack = compAudio {
                if let filmAudio = film.tracks(withMediaType: .audio).first {
                    try audioTrack.insertTimeRange(filmRange, of: filmAudio, at: filmStart)
                }
                if let outroAudio = outro.tracks(withMediaType: .audio).first {
                    try audioTrack.insertTimeRange(outroRange, of: outroAudio, at: outroStart)
                }
            }
        } catch {
            completion(.failure(error))
            return
        }

        var instructions: [AVMutableVideoCompositionInstruction] = []

        // Instruction plan fixe : identité (le clip est déjà à renderSize).
        if let sr = stillRange {
            let inst = AVMutableVideoCompositionInstruction()
            inst.timeRange = sr
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
            layer.setTransform(.identity, at: sr.start)
            inst.layerInstructions = [layer]
            instructions.append(inst)
        }

        let filmStart = stillRange?.end ?? .zero
        // Instruction film : transform d'origine.
        let filmInstruction = AVMutableVideoCompositionInstruction()
        filmInstruction.timeRange = CMTimeRange(start: filmStart, duration: film.duration)
        let filmLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        filmLayer.setTransform(filmVideo.preferredTransform, at: filmStart)
        filmInstruction.layerInstructions = [filmLayer]
        instructions.append(filmInstruction)

        // Instruction outro : aspect fit dans renderSize (bandes noires si ratios différents).
        let outroStart = filmStart + film.duration
        let outroSize = outroVideo.naturalSize.applying(outroVideo.preferredTransform)
        let ow = abs(outroSize.width), oh = abs(outroSize.height)
        let scale = min(renderSize.width / ow, renderSize.height / oh)
        let tx = (renderSize.width - ow * scale) / 2
        let ty = (renderSize.height - oh * scale) / 2
        let outroTransform = outroVideo.preferredTransform
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: tx, y: ty))
        let outroInstruction = AVMutableVideoCompositionInstruction()
        outroInstruction.timeRange = CMTimeRange(start: outroStart, duration: outro.duration)
        let outroLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        outroLayer.setTransform(outroTransform, at: outroStart)
        outroInstruction.layerInstructions = [outroLayer]
        instructions.append(outroInstruction)

        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        videoComposition.instructions = instructions

        try? FileManager.default.removeItem(at: outURL)
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            completion(.failure(ConcatError.message("export session indisponible")))
            return
        }
        exporter.outputURL = outURL
        exporter.outputFileType = .mp4
        exporter.videoComposition = videoComposition
        exporter.shouldOptimizeForNetworkUse = true

        exporter.exportAsynchronously {
            switch exporter.status {
            case .completed:
                completion(.success(outURL.absoluteString))
            case .failed, .cancelled:
                completion(.failure(exporter.error ?? ConcatError.message("export échoué")))
            default:
                completion(.failure(ConcatError.message("export interrompu")))
            }
        }
    }
}
