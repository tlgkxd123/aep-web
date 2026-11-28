package com.zionschxma.aev3;

import android.view.Surface;

/**
 * The app's native screen (native/android/aep_app_jni.cpp, in libaevk_jni.so): the interface in native/ui, the same
 * one the desktop app has, drawn with the Vulkan engine into a surface. A handle from {@link #nativeCreate} runs its own
 * thread on the display's frame clock; every call here only queues work for it, so any thread may make them.
 */
final class NativeApp {

    private NativeApp() {}

    /**
     * Starts the app for `activity`, whose {@code chooseProject()}, {@code chooseFootageFolder()} and {@code saveFile(String, byte[])} it calls from its
     * own thread; 0 when it cannot start ({@link #nativeCreateError} says why). `density` is the display's (1 at 160
     * dpi); the recent list is kept in `settingsFolder`.
     */
    static long create(NativeAppActivity activity, float density, String settingsFolder) {
        return NativeEngine.load() ? nativeCreate(activity, density, settingsFolder) : 0;
    }

    static native long nativeCreate(Object activity, float density, String settingsFolder);
    static native String nativeCreateError();
    static native void nativeDestroy(long handle);
    static native void nativeSurface(long handle, Surface surface);
    static native void nativeSurfaceChanged(long handle);
    /** Returns once the engine no longer uses the surface. */
    static native void nativeSurfaceLost(long handle);
    /** action: 0 down, 1 move, 2 up, 3 cancel; x and y in surface pixels. */
    static native void nativeTouch(long handle, int action, float x, float y);
    static native void nativePinch(long handle, float factor, float x, float y);
    /** Surface pixels at each edge that system bars or a cutout cover. */
    static native void nativeSafeArea(long handle, float left, float top, float right, float bottom);
    static native void nativeOpen(long handle, String name, byte[] project);
    static native void nativeNotify(long handle, String message);
    /** Adds a folder of real files (a copy of the footage folder the user chose) where projects' footage is looked for. */
    static native void nativeMediaFolder(long handle, String folder);
    /** True when the app closed something; false when the back button should leave the screen. */
    static native boolean nativeBack(long handle);
}
