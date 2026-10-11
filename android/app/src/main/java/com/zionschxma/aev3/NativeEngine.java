package com.zionschxma.aev3;

import android.view.Surface;

/**
 * The native Vulkan engine (native/, built into libaevk_jni.so): renders the frame plans the web app builds
 * (src/native/plan.ts), keeps played frames on the GPU and presents them in a surface. Every method but the static
 * ones needs a handle from {@link #create}; a handle is used from one thread at a time on the native side.
 */
final class NativeEngine {

    private static Boolean loaded;
    private static String loadError;

    private NativeEngine() {}

    /** Loads the library once; false (with {@link #loadError}) on devices it does not load on. */
    static synchronized boolean load() {
        if (loaded == null) {
            try {
                System.loadLibrary("aevk_jni");
                loaded = true;
            } catch (UnsatisfiedLinkError | SecurityException e) {
                loadError = e.getMessage();
                loaded = false;
            }
        }
        return loaded;
    }

    static synchronized String loadError() {
        return loadError;
    }

    /** An engine on the device's best Vulkan GPU, or 0 when there is none ({@link #nativeCreateError} says why). */
    static long create(long poolBytes, long cacheBytes) {
        return load() ? nativeCreate(poolBytes, cacheBytes) : 0;
    }

    static native long nativeCreate(long poolBytes, long cacheBytes);
    static native String nativeCreateError();
    static native void nativeDestroy(long handle);
    /** Why the last call on the handle failed. */
    static native String nativeError(long handle);
    /** {name, Vulkan version, "true" for a CPU implementation}. */
    static native String[] nativeDevice(long handle);
    /** Straight RGBA, rows top first, with size = {width, height}; null when the plan cannot be rendered. */
    static native byte[] nativeRender(long handle, byte[] plan, int[] size);
    static native boolean nativeAttach(long handle, Surface surface);
    static native void nativeDetach(long handle);
    static native boolean nativeQueue(long handle, String view, long frame, byte[] plan);
    static native int nativeRenderAhead(long handle, double budgetMs);
    static native boolean nativeCached(long handle, String view, long frame);
    /** rect = {x, y, width, height} in surface pixels (a zero size fits the frame), background = {r, g, b}. */
    static native boolean nativeShow(long handle, String view, long frame, float[] rect, float[] background);
    static native void nativeInvalidate(long handle, String view);
    static native void nativeTrim(long handle, long poolBytes, long cacheBytes);
}
