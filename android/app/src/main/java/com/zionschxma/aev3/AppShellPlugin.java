package com.zionschxma.aev3;

import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * What the web app needs from Android: the files other apps hand it (Open with, Share), copied into the cache where
 * the WebView can fetch them, as "file" events; the back button, as "back" events while the web app listens; memory
 * pressure, as "memory" events; and a new page, instead of the app closing, when the WebView's renderer dies.
 */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    private static final String INCOMING = "incoming";
    /** A page that dies this soon after the last restart closes the app, rather than restarting it over and over. */
    private static final long RESTART_LOOP_MS = 10_000;

    /** Why the last page died ("memory" or "crash"), until the next page asks; the app's process outlives its pages. */
    private static volatile String restartReason;
    private static long lastRestart = -RESTART_LOOP_MS;

    private final ComponentCallbacks2 memory = new ComponentCallbacks2() {
        @Override
        public void onTrimMemory(int level) {
            String pressure = pressure(level);
            if (pressure != null) notifyMemory(pressure);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onLowMemory() {
            notifyMemory("low");
        }

        @Override
        public void onConfigurationChanged(@NonNull Configuration configuration) {}
    };

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
        getBridge().addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    return restart(view, Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null && detail.didCrash());
                }
            }
        );
        getContext().getApplicationContext().registerComponentCallbacks(memory);
        Intent launch = getActivity().getIntent();
        if (receive(launch)) getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
    }

    @Override
    protected void handleOnDestroy() {
        getContext().getApplicationContext().unregisterComponentCallbacks(memory);
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

    /** Why the page before this one died ("memory" or "crash"), told once; nothing after a normal start. */
    @PluginMethod
    public void restartReason(PluginCall call) {
        String reason = restartReason;
        restartReason = null;
        JSObject result = new JSObject();
        if (reason != null) result.put("reason", reason);
        call.resolve(result);
    }

    /**
     * The WebView's renderer died: Android stopped it to reclaim memory, or it crashed. Unhandled, that closes the whole
     * app; instead the dead WebView, which cannot be used again, leaves the window and the activity starts afresh with
     * a new one, whose page learns why from restartReason.
     */
    private boolean restart(WebView view, boolean crashed) {
        restartReason = crashed ? "crash" : "memory";
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        long now = SystemClock.elapsedRealtime();
        boolean looping = now - lastRestart < RESTART_LOOP_MS;
        lastRestart = now;
        if (getActivity().isFinishing()) return true;
        if (looping) getActivity().finish();
        else getActivity().recreate();
        return true;
    }

    /** The page's memory pressure (see memory.ts) for an onTrimMemory level; null for the levels it leaves alone. */
    @SuppressWarnings("deprecation")
    static String pressure(int level) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE) return "low";
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) return "background";
        if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) return "hidden";
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return "low";
        return null;
    }

    private void notifyMemory(String level) {
        JSObject data = new JSObject();
        data.put("level", level);
        notifyListeners("memory", data);
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
