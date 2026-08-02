import UIKit
import Capacitor

/**
 * ViewController Capacitor de l'app : enregistre les plugins LOCAUX (définis dans
 * ce projet Xcode, pas installés via npm). Référencé par Main.storyboard.
 */
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VideoConcatPlugin())
    }
}
