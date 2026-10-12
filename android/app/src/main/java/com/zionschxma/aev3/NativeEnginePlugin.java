package com.zionschxma.aev3;

import android.content.ComponentCallbacks2;
import android.content.res.Configuration;
import android.net.Uri;
import android.util.Base64;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The native Vulkan engine for the web app (src/native/engine.ts): renders frame plans and hands the frames to the
 * page as array buffers over a WebView message channel, or, in WebViews without one, as straight RGBA files in the
 * cache, which the page fetches; plays frames it was handed plans for into a surface laid over the page. The engine's
 * work runs on a thread of its own, so the other plugins' calls do not wait behind a render.
 */
@CapacitorPlugin(name = "NativeEngine")
public class NativeEnginePlugin extends Plugin {

    private static final String FRAMES = "aevk";
    /** Frame files handed out in turn: the page fetches each before asking for this many more. */
    private static final int FRAME_FILES = 8;
    private static final long POOL_BYTES = 192L << 20;
    private static final long CACHE_BYTES = 256L << 20;
    /** The page's object for frame requests (channelBackend in src/native/engine.ts). */
    private static final String CHANNEL = "aevkFrames";
    /** Bytes after a frame's pixels in a reply: the request's id, the frame's width and height, little-endian. */
    private static final int TRAILER = 12;

    private final ExecutorService work = Executors.newSingleThreadExecutor((r) -> new Thread(r, "aevk"));
    private long handle;
    private boolean probed;
    private String reason;
    private int nextFile;
    private FrameLayout overlay;
    private SurfaceView surface;

    private final ComponentCallbacks2 memory = new ComponentCallbacks2() {
        @Override
        public void onTrimMemory(int level) {
            if (level >= TRIM_MEMORY_RUNNING_LOW) work.execute(() -> {
                if (handle != 0) NativeEngine.nativeTrim(handle, 0, level >= TRIM_MEMORY_BACKGROUND ? 0 : CACHE_BYTES / 4);
            });
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onLowMemory() {
            onTrimMemory(TRIM_MEMORY_COMPLETE);
        }

        @Override
        public void onConfigurationChanged(@NonNull Configuration configuration) {}
    };

    @Override
    public void load() {
        getContext().registerComponentCallbacks(memory);
        // Added before the page loads, as Capacitor adds its own bridge; WebViews without array buffer messages are
        // left the files of render().
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) return;
        try {
            WebViewCompat.addWebMessageListener(getBridge().getWebView(), CHANNEL, getBridge().getAllowedOriginRules(), this::onFrameRequest);
        } catch (RuntimeException e) {
            Logger.warn("aevk", "frames go through files: " + e.getMessage());
        }
    }

    /**
     * A frame request from the page: the request's id (u32, little-endian), then the plan. The reply is the frame's
     * straight RGBA, rows top first, followed by {@link #TRAILER}, or {"id", "error"} as JSON text.
     */
    private void onFrameRequest(WebView view, WebMessageCompat message, Uri origin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame || message.getType() != WebMessageCompat.TYPE_ARRAY_BUFFER) return;
        byte[] request = message.getArrayBuffer();
        if (request.length < 4) return;
        int id = ByteBuffer.wrap(request).order(ByteOrder.LITTLE_ENDIAN).getInt(0);
        work.execute(() -> {
            long h = engine();
            if (h == 0) {
                replyError(reply, id, "no Vulkan engine: " + reason);
                return;
            }
            long size = NativeEngine.nativeRenderFrame(h, request, 4, request.length - 4);
            if (size == 0) {
                replyError(reply, id, NativeEngine.nativeError(h));
                return;
            }
            int width = (int) (size >>> 32);
            int height = (int) size;
            byte[] frame = new byte[width * height * 4 + TRAILER];
            if (!NativeEngine.nativeReadFrame(h, frame)) {
                replyError(reply, id, NativeEngine.nativeError(h));
                return;
            }
            ByteBuffer.wrap(frame, frame.length - TRAILER, TRAILER).order(ByteOrder.LITTLE_ENDIAN).putInt(id).putInt(width).putInt(height);
            reply.postMessage(frame);
        });
    }

    private static void replyError(JavaScriptReplyProxy reply, int id, String error) {
        reply.postMessage("{\"id\":" + Integer.toUnsignedString(id) + ",\"error\":" + JSONObject.quote(error == null ? "unknown" : error) + "}");
    }

    @Override
    protected void handleOnDestroy() {
        getContext().unregisterComponentCallbacks(memory);
        work.execute(() -> {
            if (handle != 0) NativeEngine.nativeDestroy(handle);
            handle = 0;
        });
        work.shutdown();
    }

    /** The engine, created on the first call; 0 (with {@link #reason}) on devices without a usable Vulkan GPU. */
    private long engine() {
        if (!probed) {
            probed = true;
            handle = NativeEngine.create(POOL_BYTES, CACHE_BYTES);
            if (handle == 0) reason = NativeEngine.loadError() != null ? NativeEngine.loadError() : NativeEngine.nativeCreateError();
        }
        return handle;
    }

    /** Runs `task` on the engine's thread with the engine, or rejects the call when there is none. */
    private void withEngine(PluginCall call, EngineTask task) {
        work.execute(() -> {
            long h = engine();
            if (h == 0) {
                call.reject("no Vulkan engine: " + reason);
                return;
            }
            try {
                task.run(h);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    private interface EngineTask {
        void run(long handle) throws Exception;
    }

    private static byte[] plan(PluginCall call) {
        String encoded = call.getString("plan");
        return encoded == null ? null : Base64.decode(encoded, Base64.DEFAULT);
    }

    @PluginMethod
    public void probe(PluginCall call) {
        work.execute(() -> {
            JSObject result = new JSObject();
            long h = engine();
            result.put("available", h != 0);
            if (h != 0) {
                String[] device = NativeEngine.nativeDevice(h);
                result.put("device", device[0]);
                result.put("vulkan", device[1]);
                result.put("software", Boolean.parseBoolean(device[2]));
            } else {
                result.put("reason", reason);
            }
            call.resolve(result);
        });
    }

    /** Renders `plan` (base64) and resolves with {path, width, height}: the frame's straight RGBA, rows top first. */
    @PluginMethod
    public void render(PluginCall call) {
        byte[] plan = plan(call);
        if (plan == null) {
            call.reject("no plan");
            return;
        }
        withEngine(call, (h) -> {
            long size = NativeEngine.nativeRenderFrame(h, plan, 0, plan.length);
            if (size == 0) {
                call.reject(NativeEngine.nativeError(h));
                return;
            }
            File dir = new File(getContext().getCacheDir(), FRAMES);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("the frame folder cannot be made");
            File file = new File(dir, "frame-" + nextFile + ".rgba");
            nextFile = (nextFile + 1) % FRAME_FILES;
            if (!NativeEngine.nativeWriteFrame(h, file.getAbsolutePath())) {
                call.reject(NativeEngine.nativeError(h));
                return;
            }
            JSObject result = new JSObject();
            result.put("path", file.getAbsolutePath());
            result.put("width", (int) (size >>> 32));
            result.put("height", (int) size);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void queue(PluginCall call) {
        byte[] plan = plan(call);
        String view = call.getString("view", "");
        long frame = call.getInt("frame", 0);
        if (plan == null) {
            call.reject("no plan");
            return;
        }
        withEngine(call, (h) -> {
            if (NativeEngine.nativeQueue(h, view, frame, plan)) call.resolve();
            else call.reject(NativeEngine.nativeError(h));
        });
    }

    @PluginMethod
    public void renderAhead(PluginCall call) {
        double budget = call.getDouble("budgetMs", 8.0);
        withEngine(call, (h) -> {
            JSObject result = new JSObject();
            result.put("rendered", NativeEngine.nativeRenderAhead(h, budget));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void cached(PluginCall call) {
        String view = call.getString("view", "");
        long frame = call.getInt("frame", 0);
        withEngine(call, (h) -> {
            JSObject result = new JSObject();
            result.put("cached", NativeEngine.nativeCached(h, view, frame));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void invalidate(PluginCall call) {
        String view = call.getString("view", "");
        withEngine(call, (h) -> {
            NativeEngine.nativeInvalidate(h, view);
            call.resolve();
        });
    }

    /** Lays a surface over the page at {x, y, width, height} (CSS pixels) for `show`; again to move it. */
    @PluginMethod
    public void attach(PluginCall call) {
        float density = getContext().getResources().getDisplayMetrics().density;
        int x = Math.round(call.getFloat("x", 0f) * density);
        int y = Math.round(call.getFloat("y", 0f) * density);
        int width = Math.max(1, Math.round(call.getFloat("width", 1f) * density));
        int height = Math.max(1, Math.round(call.getFloat("height", 1f) * density));
        getActivity().runOnUiThread(() -> {
            WebView page = getBridge().getWebView();
            if (!(page.getParent() instanceof ViewGroup)) {
                call.reject("the page has no parent to lay a surface over");
                return;
            }
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
            params.leftMargin = x;
            params.topMargin = y;
            if (overlay == null) {
                // Not clickable, so touches go through it to the page.
                overlay = new FrameLayout(getContext());
                ((ViewGroup) page.getParent()).addView(overlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            if (surface == null) {
                surface = new SurfaceView(getContext());
                surface.setZOrderMediaOverlay(true);
                surface.getHolder().addCallback(new SurfaceHolder.Callback() {
                    @Override
                    public void surfaceCreated(@NonNull SurfaceHolder holder) {
                        work.execute(() -> {
                            if (engine() != 0) NativeEngine.nativeAttach(handle, holder.getSurface());
                        });
                    }

                    @Override
                    public void surfaceChanged(@NonNull SurfaceHolder holder, int format, int w, int h) {
                        work.execute(() -> {
                            if (engine() != 0) NativeEngine.nativeAttach(handle, holder.getSurface());
                        });
                    }

                    @Override
                    public void surfaceDestroyed(@NonNull SurfaceHolder holder) {
                        // The window must be let go of before this returns.
                        try {
                            work.submit(() -> {
                                if (handle != 0) NativeEngine.nativeDetach(handle);
                            }).get();
                        } catch (Exception ignored) {
                            // Interrupted: the engine finds the window gone at its next present.
                        }
                    }
                });
                overlay.addView(surface, params);
            } else {
                surface.setLayoutParams(params);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void detach(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (overlay != null && overlay.getParent() instanceof ViewGroup) ((ViewGroup) overlay.getParent()).removeView(overlay);
            overlay = null;
            surface = null;
            call.resolve();
        });
    }

    /** Presents a queued or cached frame in the surface over `background` ([r, g, b], 0 to 1); {shown}. */
    @PluginMethod
    public void show(PluginCall call) {
        String view = call.getString("view", "");
        long frame = call.getInt("frame", 0);
        float[] background = new float[3];
        JSArray bg = call.getArray("background");
        if (bg != null) {
            try {
                for (int i = 0; i < 3 && i < bg.length(); i++) background[i] = (float) bg.getDouble(i);
            } catch (JSONException e) {
                call.reject("background must be [r, g, b]");
                return;
            }
        }
        withEngine(call, (h) -> {
            JSObject result = new JSObject();
            result.put("shown", NativeEngine.nativeShow(h, view, frame, new float[] { 0, 0, 0, 0 }, background));
            call.resolve(result);
        });
    }
}
