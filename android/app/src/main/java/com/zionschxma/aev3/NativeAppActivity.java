package com.zionschxma.aev3;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * The app's native screen: the interface in native/ui (Project, the viewer, playback controls, the Timeline and layer
 * details) drawn by the C++ core and the Vulkan engine into a full-screen SurfaceView, with no WebView. A finger works as
 * a pointer, a pinch zooms the viewer, and projects come from the system's file picker or from Open with and Share.
 * Devices without Vulkan go to the web app (MainActivity) instead.
 */
public class NativeAppActivity extends Activity implements SurfaceHolder.Callback {

    private static final int CHOOSE_PROJECT = 1;
    private static final int CHOOSE_FOOTAGE = 2;
    /** The files a project's footage and sounds can be: what the engine decodes, and what it may one day. */
    private static final String[] FOOTAGE_EXTENSIONS = {
        "png", "jpg", "jpeg", "bmp", "tif", "tiff", "gif", "webp", "heic", "psd", "exr",
        "mp4", "mov", "m4v", "3gp", "webm", "mkv", "avi", "wav", "aif", "aiff", "mp3", "m4a", "aac", "ogg", "flac",
    };
    /** Folder levels below the chosen one that are searched. */
    private static final int FOOTAGE_DEPTH = 8;

    private volatile long handle;
    private SurfaceView surface;
    private ScaleGestureDetector pinch;
    /** Set once a second finger lands: the first one no longer acts as a pointer until every finger lifts. */
    private boolean pinching;
    private OnBackInvokedCallback backCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handle = NativeApp.create(this, getResources().getDisplayMetrics().density, getFilesDir().getAbsolutePath());
        if (handle == 0) {
            String why = NativeEngine.load() ? NativeApp.nativeCreateError() : NativeEngine.loadError();
            Toast.makeText(this, "This device cannot run the native player (" + why + "), so the web app opens instead.", Toast.LENGTH_LONG).show();
            Intent web = new Intent(this, MainActivity.class);
            if (getIntent() != null && getIntent().getData() != null) {
                web.setAction(getIntent().getAction());
                web.setData(getIntent().getData());
                web.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            startActivity(web);
            finish();
            return;
        }

        drawBehindSystemBars();
        surface = new SurfaceView(this);
        surface.getHolder().addCallback(this);
        surface.setOnApplyWindowInsetsListener(this::onInsets);
        pinch = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector detector) {
                NativeApp.nativePinch(handle, detector.getScaleFactor(), detector.getFocusX(), detector.getFocusY());
                return true;
            }
        });
        surface.setOnTouchListener(this::onTouch);
        setContentView(surface);

        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::onBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        openFromIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (handle != 0) {
            NativeApp.nativeDestroy(handle);
            handle = 0;
        }
        super.onDestroy();
    }

    /** Before Android 13 (and where the predictive back callback is not used). */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        onBack();
    }

    private void onBack() {
        if (handle == 0 || !NativeApp.nativeBack(handle)) {
            finish();
        }
    }

    // --- the surface ------------------------------------------------------------------------------------------------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        NativeApp.nativeSurface(handle, holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        NativeApp.nativeSurfaceChanged(handle);
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        NativeApp.nativeSurfaceLost(handle);
    }

    @SuppressWarnings("deprecation")
    private void drawBehindSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        getWindow().setStatusBarColor(0);
        getWindow().setNavigationBarColor(0);
    }

    /** The bars and the camera cutout the interface keeps clear of. */
    @SuppressWarnings("deprecation")
    private WindowInsets onInsets(View view, WindowInsets insets) {
        float left, top, right, bottom;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            left = bars.left;
            top = bars.top;
            right = bars.right;
            bottom = bars.bottom;
        } else {
            left = insets.getSystemWindowInsetLeft();
            top = insets.getSystemWindowInsetTop();
            right = insets.getSystemWindowInsetRight();
            bottom = insets.getSystemWindowInsetBottom();
        }
        NativeApp.nativeSafeArea(handle, left, top, right, bottom);
        return insets;
    }

    private boolean onTouch(View view, MotionEvent event) {
        pinch.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                pinching = false;
                NativeApp.nativeTouch(handle, 0, event.getX(), event.getY());
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (!pinching) {
                    pinching = true;
                    NativeApp.nativeTouch(handle, 3, 0, 0);
                }
                break;
            case MotionEvent.ACTION_MOVE:
                if (!pinching) {
                    NativeApp.nativeTouch(handle, 1, event.getX(), event.getY());
                }
                break;
            case MotionEvent.ACTION_UP:
                if (!pinching) {
                    NativeApp.nativeTouch(handle, 2, event.getX(), event.getY());
                }
                pinching = false;
                break;
            case MotionEvent.ACTION_CANCEL:
                NativeApp.nativeTouch(handle, 3, 0, 0);
                pinching = false;
                break;
            default:
                break;
        }
        return true;
    }

    // --- what the native app asks of the platform -------------------------------------------------------------------

    /** Called from the app's thread: shows the system's file picker; the project it returns goes to the app. */
    @SuppressWarnings("unused")
    void chooseProject() {
        runOnUiThread(() -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            // Android has no type for .aep: file managers list it as binary data, so every file is offered.
            pick.setType("*/*");
            try {
                startActivityForResult(pick, CHOOSE_PROJECT);
            } catch (android.content.ActivityNotFoundException e) {
                NativeApp.nativeNotify(handle, "This device has no file picker to choose a project with.");
            }
        });
    }

    /**
     * Called from the app's thread: lets the user choose the folder that holds a project's footage. Android hands apps
     * folders as documents, not paths, so its media files are copied into the app's cache (once; unchanged files are
     * kept) and that copy goes to the app, which looks for footage there as it does next to a project on the desktop.
     */
    @SuppressWarnings("unused")
    void chooseFootageFolder() {
        runOnUiThread(() -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            try {
                startActivityForResult(pick, CHOOSE_FOOTAGE);
            } catch (android.content.ActivityNotFoundException e) {
                NativeApp.nativeNotify(handle, "This device has no file picker to choose a folder with.");
            }
        });
    }

    /** Copies the media files under the folder `tree` into the cache, then hands the copy to the app. */
    private void addFootageFolder(Uri tree) {
        final long app = handle;
        new Thread(() -> {
            try {
                String id = DocumentsContract.getTreeDocumentId(tree);
                File root = new File(new File(getCacheDir(), "footage"), safeName(tree.getAuthority() + "_" + id));
                int[] copied = {0};
                copyFootage(tree, id, root, 0, copied);
                if (handle == app && app != 0) {
                    NativeApp.nativeMediaFolder(app, root.getAbsolutePath());
                    NativeApp.nativeNotify(app, copied[0] == 0 ? "No footage files were found in that folder." : "Looking for footage in the chosen folder.");
                }
            } catch (Exception e) {
                if (handle == app && app != 0) {
                    NativeApp.nativeNotify(app, "The folder could not be read: " + e.getMessage());
                }
            }
        }, "aep-footage").start();
    }

    private void copyFootage(Uri tree, String parentId, File into, int depth, int[] copied) throws java.io.IOException {
        if (depth > FOOTAGE_DEPTH) {
            return;
        }
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        };
        try (Cursor cursor = getContentResolver().query(children, columns, null, null, null)) {
            if (cursor == null) {
                return;
            }
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                if (id == null || name == null || name.startsWith(".")) {
                    continue;
                }
                File target = new File(into, safeName(name));
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) {
                    copyFootage(tree, id, target, depth + 1, copied);
                    continue;
                }
                if (!isFootage(name)) {
                    continue;
                }
                long size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                copied[0]++;
                if (size >= 0 && target.length() == size) {
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new java.io.IOException("the app's cache has no room for " + name);
                }
                File partial = new File(target.getPath() + ".part");
                try (InputStream in = getContentResolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, id));
                     OutputStream out = new FileOutputStream(partial)) {
                    if (in == null) {
                        continue;
                    }
                    byte[] buffer = new byte[1 << 16];
                    for (int read; (read = in.read(buffer)) > 0; ) {
                        out.write(buffer, 0, read);
                    }
                }
                if (!partial.renameTo(target)) {
                    throw new java.io.IOException(name + " could not be copied");
                }
            }
        }
    }

    private static boolean isFootage(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) {
            return false;
        }
        String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (String e : FOOTAGE_EXTENSIONS) {
            if (e.equals(extension)) {
                return true;
            }
        }
        return false;
    }

    /** A document's name or id as a single file name: no separators, nothing that climbs out of the folder. */
    private static String safeName(String name) {
        String safe = name.replaceAll("[/\\\\:\\u0000]", "_");
        return safe.equals(".") || safe.equals("..") || safe.isEmpty() ? "_" : safe;
    }

    /**
     * Called from the app's thread: saves a file the user asked for (a frame as PNG) in Pictures/aep; null when it was
     * saved, otherwise why not.
     */
    @SuppressWarnings("unused")
    String saveFile(String name, byte[] bytes) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, name.endsWith(".png") ? "image/png" : "application/octet-stream");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/aep");
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    return "the picture library did not take it";
                }
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        return "the picture library did not take it";
                    }
                    out.write(bytes);
                }
            } else {
                File folder = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                if (folder == null) {
                    return "there is no storage to save it in";
                }
                try (OutputStream out = new FileOutputStream(new File(folder, name))) {
                    out.write(bytes);
                }
            }
            return null;
        } catch (Exception e) {
            return e.getMessage() != null ? e.getMessage() : e.toString();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CHOOSE_PROJECT && resultCode == RESULT_OK && data != null && data.getData() != null) {
            open(data.getData());
        } else if (requestCode == CHOOSE_FOOTAGE && resultCode == RESULT_OK && data != null && data.getData() != null) {
            addFootageFolder(data.getData());
        }
    }

    private void openFromIntent(Intent intent) {
        if (intent == null || handle == 0) {
            return;
        }
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = streamOf(intent);
        }
        if (uri != null) {
            open(uri);
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri streamOf(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /** Reads the project off the main thread (a cloud file may download first), then hands it to the app. */
    private void open(Uri uri) {
        final long app = handle;
        new Thread(() -> {
            String name = nameOf(uri);
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    throw new java.io.IOException("it could not be opened");
                }
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[1 << 16];
                for (int read; (read = in.read(buffer)) > 0; ) {
                    bytes.write(buffer, 0, read);
                }
                if (handle == app && app != 0) {
                    NativeApp.nativeOpen(app, name, bytes.toByteArray());
                }
            } catch (Exception e) {
                if (handle == app && app != 0) {
                    NativeApp.nativeNotify(app, name + " could not be read: " + e.getMessage());
                }
            }
        }, "aep-open").start();
    }

    private String nameOf(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getString(0);
            }
        } catch (Exception ignored) {
            // A provider without names: the path's last part below.
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "project.aep";
    }
}
