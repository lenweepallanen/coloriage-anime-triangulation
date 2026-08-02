import Foundation
import Capacitor
import AVFoundation
import UIKit

/**
 * Plugin local : colle la vidéo outro PicoPop (bundlée dans public/outro-picopop.mp4)
 * à la fin d'une vidéo de film enregistrée, via AVFoundation (encodage matériel).
 *
 * JS : VideoConcat.appendOutro({ inputPath, outputPath }) → { uri }
 *  - inputPath  : chemin fichier absolu (file://... ou chemin brut) de la vidéo film
 *  - outputPath : chemin fichier absolu du .mp4 à produire (écrasé s'il existe)
 *
 * L'outro (1920×1080) est mis à l'échelle « aspect fit » dans la résolution du film.
 */
@objc(VideoConcatPlugin)
public class VideoConcatPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoConcatPlugin"
    public let jsName = "VideoConcat"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "appendOutro", returnType: CAPPluginReturnPromise)
    ]

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

        DispatchQueue.global(qos: .userInitiated).async {
            self.concat(filmURL: filmURL, outroURL: outroURL, outURL: outURL) { result in
                switch result {
                case .success(let uri):
                    call.resolve(["uri": uri])
                case .failure(let err):
                    call.reject("Concat impossible : \(err.localizedDescription)")
                }
            }
        }
    }

    private enum ConcatError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            if case .message(let m) = self { return m }
            return nil
        }
    }

    private func concat(filmURL: URL, outroURL: URL, outURL: URL, completion: @escaping (Result<String, Error>) -> Void) {
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

        let composition = AVMutableComposition()
        guard let compVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            completion(.failure(ConcatError.message("création piste vidéo impossible")))
            return
        }
        let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        let filmRange = CMTimeRange(start: .zero, duration: film.duration)
        let outroRange = CMTimeRange(start: .zero, duration: outro.duration)

        do {
            try compVideo.insertTimeRange(filmRange, of: filmVideo, at: .zero)
            try compVideo.insertTimeRange(outroRange, of: outroVideo, at: film.duration)
            if let audioTrack = compAudio {
                if let filmAudio = film.tracks(withMediaType: .audio).first {
                    try audioTrack.insertTimeRange(filmRange, of: filmAudio, at: .zero)
                }
                if let outroAudio = outro.tracks(withMediaType: .audio).first {
                    try audioTrack.insertTimeRange(outroRange, of: outroAudio, at: film.duration)
                }
            }
        } catch {
            completion(.failure(error))
            return
        }

        // Taille de rendu = taille du film (dimensions paires exigées par H.264).
        let filmSize = filmVideo.naturalSize.applying(filmVideo.preferredTransform)
        let renderW = floor(abs(filmSize.width) / 2) * 2
        let renderH = floor(abs(filmSize.height) / 2) * 2
        let renderSize = CGSize(width: max(renderW, 2), height: max(renderH, 2))

        // Instruction film : transform d'origine.
        let filmInstruction = AVMutableVideoCompositionInstruction()
        filmInstruction.timeRange = CMTimeRange(start: .zero, duration: film.duration)
        let filmLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        filmLayer.setTransform(filmVideo.preferredTransform, at: .zero)
        filmInstruction.layerInstructions = [filmLayer]

        // Instruction outro : aspect fit dans renderSize (bandes noires si ratios différents).
        let outroSize = outroVideo.naturalSize.applying(outroVideo.preferredTransform)
        let ow = abs(outroSize.width), oh = abs(outroSize.height)
        let scale = min(renderSize.width / ow, renderSize.height / oh)
        let tx = (renderSize.width - ow * scale) / 2
        let ty = (renderSize.height - oh * scale) / 2
        let outroTransform = outroVideo.preferredTransform
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: tx, y: ty))
        let outroInstruction = AVMutableVideoCompositionInstruction()
        outroInstruction.timeRange = CMTimeRange(start: film.duration, duration: outro.duration)
        let outroLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        outroLayer.setTransform(outroTransform, at: film.duration)
        outroInstruction.layerInstructions = [outroLayer]

        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        videoComposition.instructions = [filmInstruction, outroInstruction]

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
