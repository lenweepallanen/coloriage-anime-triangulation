package app.picopop.mobile;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lit l'Install Referrer du Play Store (ex. "utm_source=picopop&utm_medium=qr-web&project=<id>"). Une valeur par installation. */
@CapacitorPlugin(name = "InstallReferrer")
public class InstallReferrerPlugin extends Plugin {
    @PluginMethod
    public void get(final PluginCall call) {
        final InstallReferrerClient client = InstallReferrerClient.newBuilder(getContext()).build();
        try {
            client.startConnection(new InstallReferrerStateListener() {
                @Override
                public void onInstallReferrerSetupFinished(int code) {
                    JSObject ret = new JSObject();
                    try {
                        if (code == InstallReferrerClient.InstallReferrerResponse.OK) {
                            ReferrerDetails d = client.getInstallReferrer();
                            ret.put("referrer", d.getInstallReferrer());
                        }
                    } catch (Exception ignored) {
                    }
                    try { client.endConnection(); } catch (Exception ignored) {}
                    call.resolve(ret);
                }

                @Override
                public void onInstallReferrerServiceDisconnected() {}
            });
        } catch (Exception e) {
            call.resolve(new JSObject());
        }
    }
}
