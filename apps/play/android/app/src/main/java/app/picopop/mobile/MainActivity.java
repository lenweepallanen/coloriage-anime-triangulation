package app.picopop.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(InstallReferrerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
