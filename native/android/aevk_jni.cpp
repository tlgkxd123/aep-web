// The engine for the Android app's NativeEnginePlugin (android/app/src/main/java/.../NativeEngine.java): one engine and
// player per handle, behind a mutex, since the plugin's calls and the surface's callbacks come on different threads.
#include <android/log.h>
#include <android/native_window_jni.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "engine.h"
#include "playback.h"

namespace {

struct Session {
  std::mutex lock;
  std::unique_ptr<aevk::Engine> engine;
  std::unique_ptr<aevk::Player> player;
  std::string error;
};

std::mutex createLock;
std::string createError;

Session* session(jlong handle) { return reinterpret_cast<Session*>(handle); }

std::string utf(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* chars = env->GetStringUTFChars(s, nullptr);
  std::string out(chars ? chars : "");
  if (chars) env->ReleaseStringUTFChars(s, chars);
  return out;
}

std::vector<uint8_t> bytes(JNIEnv* env, jbyteArray array) {
  std::vector<uint8_t> out(array ? size_t(env->GetArrayLength(array)) : 0);
  if (!out.empty()) env->GetByteArrayRegion(array, 0, jsize(out.size()), reinterpret_cast<jbyte*>(out.data()));
  return out;
}

/** rect = {x, y, width, height} in window pixels, background = {r, g, b}. */
void presentArgs(JNIEnv* env, jfloatArray rect, jfloatArray background, aevk::PresentRect& r, float bg[3]) {
  float values[4] = {0, 0, 0, 0};
  if (rect && env->GetArrayLength(rect) >= 4) env->GetFloatArrayRegion(rect, 0, 4, values);
  r = {values[0], values[1], values[2], values[3]};
  bg[0] = bg[1] = bg[2] = 0;
  if (background && env->GetArrayLength(background) >= 3) env->GetFloatArrayRegion(background, 0, 3, bg);
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeCreate(JNIEnv*, jclass, jlong poolBytes, jlong cacheBytes) {
  aevk::EngineOptions options;
  options.presentation = true;
  if (poolBytes > 0) options.poolBudget = size_t(poolBytes);
  std::string error;
  auto engine = aevk::Engine::create(options, error);
  if (!engine) {
    std::lock_guard<std::mutex> guard(createLock);
    createError = error;
    __android_log_print(ANDROID_LOG_WARN, "aevk", "no Vulkan engine: %s", error.c_str());
    return 0;
  }
  auto* s = new Session();
  s->engine = std::move(engine);
  s->player = std::make_unique<aevk::Player>(*s->engine, cacheBytes > 0 ? size_t(cacheBytes) : size_t(256) << 20);
  return reinterpret_cast<jlong>(s);
}

JNIEXPORT jstring JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeCreateError(JNIEnv* env, jclass) {
  std::lock_guard<std::mutex> guard(createLock);
  return env->NewStringUTF(createError.c_str());
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  Session* s = session(handle);
  if (!s) return;
  {
    std::lock_guard<std::mutex> guard(s->lock);
    s->player.reset();
    s->engine.reset();
  }
  delete s;
}

JNIEXPORT jstring JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeError(JNIEnv* env, jclass, jlong handle) {
  Session* s = session(handle);
  std::lock_guard<std::mutex> guard(s->lock);
  return env->NewStringUTF(s->error.c_str());
}

/** {name, apiVersion, software} */
JNIEXPORT jobjectArray JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeDevice(JNIEnv* env, jclass, jlong handle) {
  Session* s = session(handle);
  std::lock_guard<std::mutex> guard(s->lock);
  const aevk::DeviceInfo& d = s->engine->device();
  const std::string version = std::to_string(d.apiVersion >> 22 & 0x7f) + "." + std::to_string(d.apiVersion >> 12 & 0x3ff) + "." +
                              std::to_string(d.apiVersion & 0xfff);
  jobjectArray out = env->NewObjectArray(3, env->FindClass("java/lang/String"), nullptr);
  env->SetObjectArrayElement(out, 0, env->NewStringUTF(d.name.c_str()));
  env->SetObjectArrayElement(out, 1, env->NewStringUTF(version.c_str()));
  env->SetObjectArrayElement(out, 2, env->NewStringUTF(d.software ? "true" : "false"));
  return out;
}

/** Straight RGBA, rows top first, with size = {width, height}; null when the plan cannot be rendered. */
JNIEXPORT jbyteArray JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeRender(JNIEnv* env, jclass, jlong handle, jbyteArray planBytes,
                                                                               jintArray size) {
  Session* s = session(handle);
  const std::vector<uint8_t> data = bytes(env, planBytes);
  std::lock_guard<std::mutex> guard(s->lock);
  aevk::Plan plan;
  std::vector<uint8_t> rgba;
  uint32_t width = 0, height = 0;
  if (!aevk::decodePlan(data.data(), data.size(), plan, s->error) || !s->engine->render(plan, rgba, width, height, s->error)) return nullptr;
  const jint dims[2] = {jint(width), jint(height)};
  if (size && env->GetArrayLength(size) >= 2) env->SetIntArrayRegion(size, 0, 2, dims);
  jbyteArray out = env->NewByteArray(jsize(rgba.size()));
  if (out) env->SetByteArrayRegion(out, 0, jsize(rgba.size()), reinterpret_cast<const jbyte*>(rgba.data()));
  return out;
}

JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeAttach(JNIEnv* env, jclass, jlong handle, jobject surface) {
  Session* s = session(handle);
  ANativeWindow* window = surface ? ANativeWindow_fromSurface(env, surface) : nullptr;
  std::lock_guard<std::mutex> guard(s->lock);
  if (!window) {
    s->error = "the surface has no window";
    return JNI_FALSE;
  }
  const bool attached = s->engine->attachWindow(window, s->error);
  ANativeWindow_release(window);
  return attached ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeDetach(JNIEnv*, jclass, jlong handle) {
  Session* s = session(handle);
  std::lock_guard<std::mutex> guard(s->lock);
  s->engine->detachWindow();
}

JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeQueue(JNIEnv* env, jclass, jlong handle, jstring view, jlong frame,
                                                                            jbyteArray planBytes) {
  Session* s = session(handle);
  const std::string name = utf(env, view);
  const std::vector<uint8_t> data = bytes(env, planBytes);
  std::lock_guard<std::mutex> guard(s->lock);
  return s->player->queue(name, frame, data.data(), data.size(), s->error) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeRenderAhead(JNIEnv*, jclass, jlong handle, jdouble budgetMs) {
  Session* s = session(handle);
  std::lock_guard<std::mutex> guard(s->lock);
  return s->player->renderAhead(budgetMs, s->error);
}

JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeCached(JNIEnv* env, jclass, jlong handle, jstring view, jlong frame) {
  Session* s = session(handle);
  const std::string name = utf(env, view);
  std::lock_guard<std::mutex> guard(s->lock);
  return s->player->cached(name, frame) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeShow(JNIEnv* env, jclass, jlong handle, jstring view, jlong frame,
                                                                           jfloatArray rect, jfloatArray background) {
  Session* s = session(handle);
  const std::string name = utf(env, view);
  aevk::PresentRect r;
  float bg[3];
  presentArgs(env, rect, background, r, bg);
  std::lock_guard<std::mutex> guard(s->lock);
  return s->player->show(name, frame, r, bg, s->error) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeInvalidate(JNIEnv* env, jclass, jlong handle, jstring view) {
  Session* s = session(handle);
  const std::string name = utf(env, view);
  std::lock_guard<std::mutex> guard(s->lock);
  s->player->invalidate(name);
}

/** Gives back pooled targets beyond `poolBytes` and cached frames beyond `cacheBytes` (memory pressure). */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeTrim(JNIEnv*, jclass, jlong handle, jlong poolBytes, jlong cacheBytes) {
  Session* s = session(handle);
  std::lock_guard<std::mutex> guard(s->lock);
  auto& cache = s->player->cache();
  const size_t budget = cache.budget();
  cache.setBudget(size_t(cacheBytes > 0 ? cacheBytes : 0));
  cache.setBudget(budget);
  s->engine->trim(size_t(poolBytes > 0 ? poolBytes : 0));
}

}  // extern "C"
