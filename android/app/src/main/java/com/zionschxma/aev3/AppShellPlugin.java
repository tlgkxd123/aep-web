package com.zionschxma.aev3;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * What the web app needs from Android: the files other apps hand it (Open with, Share), copied into the cache where
 * the WebView can fetch them, as "file" events; and the back button, as "back" events while the web app listens.
 */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    private static final String INCOMING = "incoming";

    @Override
    public void load() {
        OnBackPressedCallback back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (hasListeners("back")) {
                    notifyListeners("back", new JSObject());
                    return;
                }
                setEnabled(false);
                getActivity().getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        };
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), back));
        Intent launch = getActivity().getIntent();
        if (receive(launch)) getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        receive(intent);
    }

    /** Closes the app, as the back button does on Android's home screen of an app. */
    @PluginMethod
    public void exit(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    private boolean receive(Intent intent) {
        Uri uri = sharedUri(intent);
        if (uri == null) return false;
        new Thread(() -> deliver(uri)).start();
        return true;
    }

    private static Uri sharedUri(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) return intent.getData();
        if (Intent.ACTION_SEND.equals(intent.getAction())) return IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        return null;
    }

    private void deliver(Uri uri) {
        String name = displayName(uri);
        JSObject data = new JSObject();
        data.put("name", name);
        try {
            File dir = new File(getContext().getCacheDir(), INCOMING);
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("cannot create " + dir);
            File out = new File(dir, name);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream o = new FileOutputStream(out)) {
                if (in == null) throw new Exception("the file could not be opened");
                byte[] buffer = new byte[1 << 16];
                for (int n; (n = in.read(buffer)) > 0; ) o.write(buffer, 0, n);
            }
            data.put("path", out.getAbsolutePath());
        } catch (Exception e) {
            data.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
        }
        notifyListeners("file", data, true);
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (Exception ignored) {
                // Providers that refuse the query still let the file be read; it then goes by its URI's name.
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.matches("\\.*")) name = "Project.aep";
        return name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
    }
}
