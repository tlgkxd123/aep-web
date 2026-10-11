#include "engine.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <stdexcept>
#include <tuple>

#include "geometry.h"
#include "shaders.inc"
#include "vk.h"

#if defined(__ANDROID__)
#include <android/native_window.h>
#endif

namespace aevk {
namespace {

constexpr VkFormat kColorFormat = VK_FORMAT_R8G8B8A8_UNORM;
/** Frames a pooled target may go unused before it is deleted. */
constexpr uint64_t kKeepFrames = 2;
constexpr uint32_t kSetsPerPool = 1024;
namespace mask_mode {
constexpr uint32_t Subtract = 6814, Intersect = 6815, Darken = 6817;
}

struct VkFailure : std::runtime_error {
  VkFailure(const char* call, VkResult result) : std::runtime_error(std::string(call) + " failed (VkResult " + std::to_string(int(result)) + ")") {}
};

#define AEVK_CHECK(call)                              \
  do {                                                \
    VkResult result_ = (call);                        \
    if (result_ != VK_SUCCESS) throw VkFailure(#call, result_); \
  } while (0)

struct LayerPush {
  float toView[16];
  float layerSize[2];
  float origin[2];
  float viewSize[2];
  float zoom;
};
struct CompositePush {
  int32_t matteMode;
  float matteOpacity;
  int32_t mode;
  float opacity;
  int32_t adjust;
};
struct CoveragePush {
  uint32_t first, count, stroked;
  float expansion;
  uint32_t evenOdd;
  uint32_t bandRows;
  float bandTop;
  uint32_t bands;
};
/** Rows per band of binned edges (coverage.frag). */
constexpr uint32_t kBandRows = 8;
struct PaintPush {
  float color[4];
  float toPaintX[4];
  float toPaintY[4];
  float startEnd[4];
  float focus[2];
  int32_t kind;
  uint32_t rampFirst;
  uint32_t rampLast;
};
struct FeatherPush {
  int32_t step[2];
  int32_t radius;
  float sigma;
  float norm;
};
struct CombinePush {
  int32_t mode, first, inverted;
  float start, opacity;
};

/** Row-major (as the plan stores matrices) to the column-major order GLSL reads. */
void transpose(const float* rowMajor, float* out) {
  for (int r = 0; r < 4; r++)
    for (int c = 0; c < 4; c++) out[c * 4 + r] = rowMajor[r * 4 + c];
}

/**
 * A color channel as the exact multiple of 1/255 the shaders' quantize() gives, so the device's rounding of ties cannot
 * move it. The product is rounded to float first (0.9f * 255 is 229.5 there, and After Effects stores 230): a fused
 * multiply-add would skip that rounding, hence the volatile.
 */
float unorm8(float c) {
  volatile float scaled = std::clamp(c, 0.0f, 1.0f) * 255.0f;
  return std::floor(scaled + 0.5f) / 255.0f;
}

}  // namespace

struct Target {
  VkImage image = VK_NULL_HANDLE;
  VkDeviceMemory memory = VK_NULL_HANDLE;
  VkImageView view = VK_NULL_HANDLE;
  VkFramebuffer framebuffer = VK_NULL_HANDLE;
  uint32_t width = 0, height = 0;
  VkFormat format = kColorFormat;
  size_t bytes = 0;
  uint64_t released = 0;
  uint64_t frame = 0;
};

struct Buffer {
  VkBuffer buffer = VK_NULL_HANDLE;
  VkDeviceMemory memory = VK_NULL_HANDLE;
  void* mapped = nullptr;
  VkDeviceSize size = 0;
};

/** A layer's image in its own pixels (see LayerImage in src/render/registry.ts). */
struct LayerImage {
  Target* target = nullptr;
  uint32_t width = 0, height = 0;
  float originX = 0, originY = 0;
  float scale = 1;
};

struct Frame::State {
  Engine::Impl* impl = nullptr;
  Target* target = nullptr;
};

struct Swapchain {
  VkSurfaceKHR surface = VK_NULL_HANDLE;
  VkSwapchainKHR swapchain = VK_NULL_HANDLE;
  VkFormat format = VK_FORMAT_UNDEFINED;
  VkExtent2D extent{};
  VkRenderPass pass = VK_NULL_HANDLE;
  VkPipeline pipeline = VK_NULL_HANDLE;
  std::vector<VkImage> images;
  std::vector<VkImageView> views;
  std::vector<VkFramebuffer> framebuffers;
  VkSemaphore acquired = VK_NULL_HANDLE;
  VkSemaphore rendered = VK_NULL_HANDLE;
#if defined(__ANDROID__)
  ANativeWindow* window = nullptr;
#endif
};

struct Engine::Impl {
  EngineOptions options;
  DeviceInfo info;
  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physical = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  uint32_t queueFamily = 0;
  bool swapchainExtension = false;
  VkPhysicalDeviceMemoryProperties memoryProperties{};
  VkDeviceSize storageAlignment = 256;
  VkFormat coverageFormat = VK_FORMAT_R32_SFLOAT;
  VkCommandPool commandPool = VK_NULL_HANDLE;
  VkCommandBuffer cmd = VK_NULL_HANDLE;
  VkFence fence = VK_NULL_HANDLE;
  bool recording = false;
  VkDescriptorSetLayout setLayout = VK_NULL_HANDLE;
  VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
  VkDescriptorPool descriptorPool = VK_NULL_HANDLE;
  VkSampler linear = VK_NULL_HANDLE;
  VkSampler nearest = VK_NULL_HANDLE;
  std::map<VkFormat, VkRenderPass> passes;
  std::vector<VkShaderModule> modules;
  VkShaderModule layerVert = VK_NULL_HANDLE, fullscreenVert = VK_NULL_HANDLE, layerFrag = VK_NULL_HANDLE;
  VkPipeline layerPipe = VK_NULL_HANDLE, compositePipe = VK_NULL_HANDLE, maskPipe = VK_NULL_HANDLE, premultiplyPipe = VK_NULL_HANDLE;
  VkPipeline coveragePipe = VK_NULL_HANDLE, featherPipe = VK_NULL_HANDLE, combinePipe = VK_NULL_HANDLE, paintPipe = VK_NULL_HANDLE;
  Buffer edges;
  VkDeviceSize edgesUsed = 0;
  Buffer staging;
  Target* dummy = nullptr;
  std::map<std::tuple<uint32_t, uint32_t, VkFormat>, std::vector<Target*>> free;
  size_t freeBytes = 0;
  uint64_t releases = 0;
  uint64_t frameNumber = 0;
  const Plan* plan = nullptr;
  Swapchain swap;

  ~Impl() { destroy(); }

  // --- setup ---------------------------------------------------------------------------------------------------

  void init() {
    const char* loadError = nullptr;
    if (!vk::loadLibrary(&loadError)) throw std::runtime_error(loadError);
    createInstance();
    pickDevice();
    createDevice();
    createResources();
  }

  void createInstance() {
    uint32_t count = 0;
    vk::vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr);
    std::vector<VkExtensionProperties> available(count);
    vk::vkEnumerateInstanceExtensionProperties(nullptr, &count, available.data());
    auto has = [&](const char* name) { return std::any_of(available.begin(), available.end(), [&](const VkExtensionProperties& e) { return !std::strcmp(e.extensionName, name); }); };
    std::vector<const char*> extensions;
#if defined(__ANDROID__)
    if (options.presentation && has(VK_KHR_SURFACE_EXTENSION_NAME) && has(VK_KHR_ANDROID_SURFACE_EXTENSION_NAME)) {
      extensions.push_back(VK_KHR_SURFACE_EXTENSION_NAME);
      extensions.push_back(VK_KHR_ANDROID_SURFACE_EXTENSION_NAME);
    }
#else
    (void)has;
#endif
    std::vector<const char*> layers;
    const char* env = std::getenv("AEVK_VALIDATION");
    if (options.validation || (env && *env && std::strcmp(env, "0"))) layers.push_back("VK_LAYER_KHRONOS_validation");
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "aep-web";
    app.pEngineName = "aevk";
    app.apiVersion = VK_API_VERSION_1_0;
    VkInstanceCreateInfo create{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    create.pApplicationInfo = &app;
    create.enabledExtensionCount = uint32_t(extensions.size());
    create.ppEnabledExtensionNames = extensions.data();
    create.enabledLayerCount = uint32_t(layers.size());
    create.ppEnabledLayerNames = layers.data();
    VkResult result = vk::vkCreateInstance(&create, nullptr, &instance);
    if (result == VK_ERROR_LAYER_NOT_PRESENT) {
      create.enabledLayerCount = 0;
      result = vk::vkCreateInstance(&create, nullptr, &instance);
    }
    if (result != VK_SUCCESS) throw VkFailure("vkCreateInstance", result);
    vk::loadInstance(instance);
  }

  void pickDevice() {
    uint32_t count = 0;
    vk::vkEnumeratePhysicalDevices(instance, &count, nullptr);
    std::vector<VkPhysicalDevice> devices(count);
    vk::vkEnumeratePhysicalDevices(instance, &count, devices.data());
    int best = -1;
    for (VkPhysicalDevice candidate : devices) {
      uint32_t families = 0;
      vk::vkGetPhysicalDeviceQueueFamilyProperties(candidate, &families, nullptr);
      std::vector<VkQueueFamilyProperties> props(families);
      vk::vkGetPhysicalDeviceQueueFamilyProperties(candidate, &families, props.data());
      int family = -1;
      for (uint32_t i = 0; i < families && family < 0; i++)
        if (props[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) family = int(i);
      if (family < 0) continue;
      VkPhysicalDeviceProperties p;
      vk::vkGetPhysicalDeviceProperties(candidate, &p);
      const char* forced = std::getenv("AEVK_DEVICE");
      int score = p.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU     ? 4
                  : p.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ? 3
                  : p.deviceType == VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU    ? 2
                                                                           : 1;
      if (forced && *forced && std::strstr(p.deviceName, forced)) score = 100;
      if (score <= best) continue;
      best = score;
      physical = candidate;
      queueFamily = uint32_t(family);
      info.name = p.deviceName;
      info.apiVersion = p.apiVersion;
      info.vendorId = p.vendorID;
      info.software = p.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU;
      storageAlignment = std::max<VkDeviceSize>(16, p.limits.minStorageBufferOffsetAlignment);
    }
    if (!physical) throw std::runtime_error("no Vulkan device can render");
    vk::vkGetPhysicalDeviceMemoryProperties(physical, &memoryProperties);
    // Mask coverage keeps full precision between passes where the device can render to float targets.
    for (VkFormat format : {VK_FORMAT_R32_SFLOAT, VK_FORMAT_R16_SFLOAT, kColorFormat}) {
      VkFormatProperties props;
      vk::vkGetPhysicalDeviceFormatProperties(physical, format, &props);
      const VkFormatFeatureFlags need = VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT;
      if ((props.optimalTilingFeatures & need) == need) {
        coverageFormat = format;
        break;
      }
    }
  }

  void createDevice() {
    uint32_t count = 0;
    vk::vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, nullptr);
    std::vector<VkExtensionProperties> available(count);
    vk::vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, available.data());
    std::vector<const char*> extensions;
    if (options.presentation)
      for (const VkExtensionProperties& e : available)
        if (!std::strcmp(e.extensionName, VK_KHR_SWAPCHAIN_EXTENSION_NAME)) {
          extensions.push_back(VK_KHR_SWAPCHAIN_EXTENSION_NAME);
          swapchainExtension = true;
        }
    const float priority = 1;
    VkDeviceQueueCreateInfo queueInfo{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queueInfo.queueFamilyIndex = queueFamily;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;
    VkDeviceCreateInfo create{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    create.queueCreateInfoCount = 1;
    create.pQueueCreateInfos = &queueInfo;
    create.enabledExtensionCount = uint32_t(extensions.size());
    create.ppEnabledExtensionNames = extensions.data();
    AEVK_CHECK(vk::vkCreateDevice(physical, &create, nullptr, &device));
    vk::loadDevice(device);
    vk::vkGetDeviceQueue(device, queueFamily, 0, &queue);
  }

  VkShaderModule shader(const uint32_t* code, size_t bytes) {
    VkShaderModuleCreateInfo create{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    create.codeSize = bytes;
    create.pCode = code;
    VkShaderModule module;
    AEVK_CHECK(vk::vkCreateShaderModule(device, &create, nullptr, &module));
    modules.push_back(module);
    return module;
  }

  /** A render pass over one target of `format` that clears it and leaves it ready to sample (or to present). */
  VkRenderPass renderPass(VkFormat format, VkImageLayout finalLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL) {
    VkAttachmentDescription attachment{};
    attachment.format = format;
    attachment.samples = VK_SAMPLE_COUNT_1_BIT;
    attachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    attachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    attachment.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    attachment.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    attachment.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    attachment.finalLayout = finalLayout;
    VkAttachmentReference ref{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass{};
    subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    subpass.colorAttachmentCount = 1;
    subpass.pColorAttachments = &ref;
    // Passes run one after another: each waits for the writes and reads of the ones before it.
    VkSubpassDependency deps[2]{};
    deps[0].srcSubpass = VK_SUBPASS_EXTERNAL;
    deps[0].dstSubpass = 0;
    deps[0].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT;
    deps[0].srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
    deps[0].dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
    deps[0].dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_SHADER_READ_BIT;
    deps[1].srcSubpass = 0;
    deps[1].dstSubpass = VK_SUBPASS_EXTERNAL;
    deps[1].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    deps[1].srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
    deps[1].dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT;
    deps[1].dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_TRANSFER_READ_BIT;
    VkRenderPassCreateInfo create{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
    create.attachmentCount = 1;
    create.pAttachments = &attachment;
    create.subpassCount = 1;
    create.pSubpasses = &subpass;
    create.dependencyCount = 2;
    create.pDependencies = deps;
    VkRenderPass pass;
    AEVK_CHECK(vk::vkCreateRenderPass(device, &create, nullptr, &pass));
    return pass;
  }

  VkPipeline pipeline(VkShaderModule vert, VkShaderModule frag, VkRenderPass pass, bool strip) {
    VkPipelineShaderStageCreateInfo stages[2]{};
    stages[0].sType = stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vert;
    stages[0].pName = "main";
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = frag;
    stages[1].pName = "main";
    VkPipelineVertexInputStateCreateInfo input{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
    VkPipelineInputAssemblyStateCreateInfo assembly{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
    assembly.topology = strip ? VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkPipelineViewportStateCreateInfo viewport{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
    viewport.viewportCount = 1;
    viewport.scissorCount = 1;
    VkPipelineRasterizationStateCreateInfo raster{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
    raster.polygonMode = VK_POLYGON_MODE_FILL;
    raster.cullMode = VK_CULL_MODE_NONE;
    raster.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
    raster.lineWidth = 1;
    VkPipelineMultisampleStateCreateInfo multisample{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
    multisample.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
    VkPipelineColorBlendAttachmentState blend{};
    blend.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    VkPipelineColorBlendStateCreateInfo blending{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
    blending.attachmentCount = 1;
    blending.pAttachments = &blend;
    const VkDynamicState dynamic[] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynamicState{VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};
    dynamicState.dynamicStateCount = 2;
    dynamicState.pDynamicStates = dynamic;
    VkGraphicsPipelineCreateInfo create{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
    create.stageCount = 2;
    create.pStages = stages;
    create.pVertexInputState = &input;
    create.pInputAssemblyState = &assembly;
    create.pViewportState = &viewport;
    create.pRasterizationState = &raster;
    create.pMultisampleState = &multisample;
    create.pColorBlendState = &blending;
    create.pDynamicState = &dynamicState;
    create.layout = pipelineLayout;
    create.renderPass = pass;
    VkPipeline result;
    AEVK_CHECK(vk::vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &create, nullptr, &result));
    return result;
  }

  void createResources() {
    VkCommandPoolCreateInfo poolInfo{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    poolInfo.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    poolInfo.queueFamilyIndex = queueFamily;
    AEVK_CHECK(vk::vkCreateCommandPool(device, &poolInfo, nullptr, &commandPool));
    VkCommandBufferAllocateInfo alloc{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    alloc.commandPool = commandPool;
    alloc.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    alloc.commandBufferCount = 1;
    AEVK_CHECK(vk::vkAllocateCommandBuffers(device, &alloc, &cmd));
    VkFenceCreateInfo fenceInfo{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    AEVK_CHECK(vk::vkCreateFence(device, &fenceInfo, nullptr, &fence));

    VkDescriptorSetLayoutBinding bindings[5]{};
    for (uint32_t i = 0; i < 4; i++) bindings[i] = {i, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
    bindings[4] = {4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
    VkDescriptorSetLayoutCreateInfo layoutInfo{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    layoutInfo.bindingCount = 5;
    layoutInfo.pBindings = bindings;
    AEVK_CHECK(vk::vkCreateDescriptorSetLayout(device, &layoutInfo, nullptr, &setLayout));
    VkPushConstantRange push{VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, 128};
    VkPipelineLayoutCreateInfo pipelineInfo{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    pipelineInfo.setLayoutCount = 1;
    pipelineInfo.pSetLayouts = &setLayout;
    pipelineInfo.pushConstantRangeCount = 1;
    pipelineInfo.pPushConstantRanges = &push;
    AEVK_CHECK(vk::vkCreatePipelineLayout(device, &pipelineInfo, nullptr, &pipelineLayout));
    VkDescriptorPoolSize sizes[2] = {{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, kSetsPerPool * 4}, {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, kSetsPerPool}};
    VkDescriptorPoolCreateInfo descriptorInfo{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    descriptorInfo.maxSets = kSetsPerPool;
    descriptorInfo.poolSizeCount = 2;
    descriptorInfo.pPoolSizes = sizes;
    AEVK_CHECK(vk::vkCreateDescriptorPool(device, &descriptorInfo, nullptr, &descriptorPool));

    for (VkFilter filter : {VK_FILTER_LINEAR, VK_FILTER_NEAREST}) {
      VkSamplerCreateInfo sampler{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
      sampler.magFilter = sampler.minFilter = filter;
      sampler.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
      sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
      sampler.maxLod = 0;
      AEVK_CHECK(vk::vkCreateSampler(device, &sampler, nullptr, filter == VK_FILTER_LINEAR ? &linear : &nearest));
    }

    passes[kColorFormat] = renderPass(kColorFormat);
    if (!passes.count(coverageFormat)) passes[coverageFormat] = renderPass(coverageFormat);
    layerVert = shader(kShader_layer_vert, sizeof kShader_layer_vert);
    fullscreenVert = shader(kShader_fullscreen_vert, sizeof kShader_fullscreen_vert);
    layerFrag = shader(kShader_layer_frag, sizeof kShader_layer_frag);
    VkRenderPass color = passes[kColorFormat];
    VkRenderPass coverage = passes[coverageFormat];
    layerPipe = pipeline(layerVert, layerFrag, color, true);
    compositePipe = pipeline(fullscreenVert, shader(kShader_composite_frag, sizeof kShader_composite_frag), color, false);
    maskPipe = pipeline(fullscreenVert, shader(kShader_mask_frag, sizeof kShader_mask_frag), color, false);
    premultiplyPipe = pipeline(fullscreenVert, shader(kShader_premultiply_frag, sizeof kShader_premultiply_frag), color, false);
    coveragePipe = pipeline(fullscreenVert, shader(kShader_coverage_frag, sizeof kShader_coverage_frag), coverage, false);
    featherPipe = pipeline(fullscreenVert, shader(kShader_feather_frag, sizeof kShader_feather_frag), coverage, false);
    combinePipe = pipeline(fullscreenVert, shader(kShader_combine_frag, sizeof kShader_combine_frag), coverage, false);
    paintPipe = pipeline(fullscreenVert, shader(kShader_paint_frag, sizeof kShader_paint_frag), color, false);

    edges = hostBuffer(1 << 16, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    dummy = createTarget(1, 1, kColorFormat);
    begin();
    clearTarget(*dummy);
    submit();
  }

  // --- memory ----------------------------------------------------------------------------------------------------

  uint32_t memoryType(uint32_t bits, VkMemoryPropertyFlags want, VkMemoryPropertyFlags prefer = 0) {
    for (VkMemoryPropertyFlags flags : {want | prefer, want}) {
      for (uint32_t i = 0; i < memoryProperties.memoryTypeCount; i++)
        if ((bits & (1u << i)) && (memoryProperties.memoryTypes[i].propertyFlags & flags) == flags) return i;
    }
    throw std::runtime_error("no suitable GPU memory type");
  }

  Buffer hostBuffer(VkDeviceSize size, VkBufferUsageFlags usage) {
    Buffer b;
    b.size = size;
    VkBufferCreateInfo create{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    create.size = size;
    create.usage = usage;
    create.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    AEVK_CHECK(vk::vkCreateBuffer(device, &create, nullptr, &b.buffer));
    VkMemoryRequirements req;
    vk::vkGetBufferMemoryRequirements(device, b.buffer, &req);
    VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    alloc.allocationSize = req.size;
    alloc.memoryTypeIndex = memoryType(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                                       usage & VK_BUFFER_USAGE_TRANSFER_DST_BIT ? VK_MEMORY_PROPERTY_HOST_CACHED_BIT : 0);
    AEVK_CHECK(vk::vkAllocateMemory(device, &alloc, nullptr, &b.memory));
    AEVK_CHECK(vk::vkBindBufferMemory(device, b.buffer, b.memory, 0));
    AEVK_CHECK(vk::vkMapMemory(device, b.memory, 0, VK_WHOLE_SIZE, 0, &b.mapped));
    return b;
  }

  void destroyBuffer(Buffer& b) {
    if (b.buffer) vk::vkDestroyBuffer(device, b.buffer, nullptr);
    if (b.memory) vk::vkFreeMemory(device, b.memory, nullptr);
    b = Buffer();
  }

  /** The staging buffer, at least `size` bytes; only while nothing is recorded that uses it. */
  Buffer& stagingFor(VkDeviceSize size) {
    if (staging.size < size) {
      destroyBuffer(staging);
      staging = hostBuffer(std::max<VkDeviceSize>(size, 1 << 20), VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    }
    return staging;
  }

  Target* createTarget(uint32_t width, uint32_t height, VkFormat format) {
    auto* t = new Target();
    t->width = width;
    t->height = height;
    t->format = format;
    VkImageCreateInfo image{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
    image.imageType = VK_IMAGE_TYPE_2D;
    image.format = format;
    image.extent = {width, height, 1};
    image.mipLevels = 1;
    image.arrayLayers = 1;
    image.samples = VK_SAMPLE_COUNT_1_BIT;
    image.tiling = VK_IMAGE_TILING_OPTIMAL;
    image.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
    image.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    image.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    AEVK_CHECK(vk::vkCreateImage(device, &image, nullptr, &t->image));
    VkMemoryRequirements req;
    vk::vkGetImageMemoryRequirements(device, t->image, &req);
    VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    alloc.allocationSize = req.size;
    alloc.memoryTypeIndex = memoryType(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    VkResult result = vk::vkAllocateMemory(device, &alloc, nullptr, &t->memory);
    if (result == VK_ERROR_OUT_OF_DEVICE_MEMORY || result == VK_ERROR_OUT_OF_HOST_MEMORY) {
      // Pooled targets nobody holds go first, once the commands recorded with them have run.
      if (recording) flush();
      trimPool(0);
      result = vk::vkAllocateMemory(device, &alloc, nullptr, &t->memory);
    }
    if (result != VK_SUCCESS) {
      vk::vkDestroyImage(device, t->image, nullptr);
      delete t;
      throw VkFailure("vkAllocateMemory", result);
    }
    t->bytes = size_t(req.size);
    AEVK_CHECK(vk::vkBindImageMemory(device, t->image, t->memory, 0));
    VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
    view.image = t->image;
    view.viewType = VK_IMAGE_VIEW_TYPE_2D;
    view.format = format;
    view.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    AEVK_CHECK(vk::vkCreateImageView(device, &view, nullptr, &t->view));
    VkFramebufferCreateInfo fb{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
    fb.renderPass = passes.at(format);
    fb.attachmentCount = 1;
    fb.pAttachments = &t->view;
    fb.width = width;
    fb.height = height;
    fb.layers = 1;
    AEVK_CHECK(vk::vkCreateFramebuffer(device, &fb, nullptr, &t->framebuffer));
    return t;
  }

  void destroyTarget(Target* t) {
    vk::vkDestroyFramebuffer(device, t->framebuffer, nullptr);
    vk::vkDestroyImageView(device, t->view, nullptr);
    vk::vkDestroyImage(device, t->image, nullptr);
    vk::vkFreeMemory(device, t->memory, nullptr);
    delete t;
  }

  /** A target of this size from the pool; its pixels are undefined until a pass writes them. */
  Target* acquire(uint32_t width, uint32_t height, VkFormat format = kColorFormat) {
    width = std::max(1u, width);
    height = std::max(1u, height);
    auto it = free.find({width, height, format});
    if (it != free.end() && !it->second.empty()) {
      Target* t = it->second.back();
      it->second.pop_back();
      freeBytes -= t->bytes;
      return t;
    }
    return createTarget(width, height, format);
  }

  void release(Target* t) {
    if (!t || t == dummy) return;
    t->released = ++releases;
    t->frame = frameNumber;
    free[{t->width, t->height, t->format}].push_back(t);
    freeBytes += t->bytes;
  }

  /**
   * Deletes pooled targets the last kKeepFrames frames did not use, then the least recently released ones until at
   * most `maxBytes` stay pooled. Only while nothing recorded is waiting to run.
   */
  void trimPool(size_t maxBytes) {
    for (auto& [key, list] : free) {
      auto keep = std::stable_partition(list.begin(), list.end(), [&](Target* t) { return frameNumber - t->frame < kKeepFrames; });
      for (auto it = keep; it != list.end(); ++it) {
        freeBytes -= (*it)->bytes;
        destroyTarget(*it);
      }
      list.erase(keep, list.end());
    }
    while (freeBytes > maxBytes) {
      std::vector<Target*>* oldest = nullptr;
      for (auto& [key, list] : free)
        if (!list.empty() && (!oldest || list.front()->released < oldest->front()->released)) oldest = &list;
      if (!oldest) break;
      Target* t = oldest->front();
      oldest->erase(oldest->begin());
      freeBytes -= t->bytes;
      destroyTarget(t);
    }
  }

  // --- recording ---------------------------------------------------------------------------------------------------

  void begin() {
    VkCommandBufferBeginInfo info{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    info.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    AEVK_CHECK(vk::vkResetCommandBuffer(cmd, 0));
    AEVK_CHECK(vk::vkBeginCommandBuffer(cmd, &info));
    recording = true;
  }

  /** Runs what was recorded and waits for it; descriptor sets and the edge buffer are free again afterwards. */
  void submit(VkSemaphore wait = VK_NULL_HANDLE, VkSemaphore signal = VK_NULL_HANDLE) {
    AEVK_CHECK(vk::vkEndCommandBuffer(cmd));
    recording = false;
    VkSubmitInfo info{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    if (wait) {
      info.waitSemaphoreCount = 1;
      info.pWaitSemaphores = &wait;
      info.pWaitDstStageMask = &stage;
    }
    if (signal) {
      info.signalSemaphoreCount = 1;
      info.pSignalSemaphores = &signal;
    }
    info.commandBufferCount = 1;
    info.pCommandBuffers = &cmd;
    AEVK_CHECK(vk::vkResetFences(device, 1, &fence));
    AEVK_CHECK(vk::vkQueueSubmit(queue, 1, &info, fence));
    AEVK_CHECK(vk::vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX));
    AEVK_CHECK(vk::vkResetDescriptorPool(device, descriptorPool, 0));
    edgesUsed = 0;
  }

  /** Runs what was recorded so far and goes on recording, when a frame needs more descriptors or edges than fit. */
  void flush() {
    submit();
    begin();
  }

  VkDescriptorSet descriptorSet(std::initializer_list<const Target*> inputs, bool nearestFilter) {
    VkDescriptorSetAllocateInfo alloc{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    alloc.descriptorPool = descriptorPool;
    alloc.descriptorSetCount = 1;
    alloc.pSetLayouts = &setLayout;
    VkDescriptorSet set;
    if (vk::vkAllocateDescriptorSets(device, &alloc, &set) != VK_SUCCESS) {
      flush();
      AEVK_CHECK(vk::vkAllocateDescriptorSets(device, &alloc, &set));
    }
    VkDescriptorImageInfo images[4];
    const Target* const* in = inputs.begin();
    for (size_t i = 0; i < 4; i++) {
      const Target* t = i < inputs.size() && in[i] ? in[i] : dummy;
      images[i] = {nearestFilter || t->format != kColorFormat ? nearest : linear, t->view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
    }
    VkDescriptorBufferInfo buffer{edges.buffer, 0, VK_WHOLE_SIZE};
    VkWriteDescriptorSet writes[2]{};
    writes[0].sType = writes[1].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[0].dstSet = writes[1].dstSet = set;
    writes[0].dstBinding = 0;
    writes[0].descriptorCount = 4;
    writes[0].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    writes[0].pImageInfo = images;
    writes[1].dstBinding = 4;
    writes[1].descriptorCount = 1;
    writes[1].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    writes[1].pBufferInfo = &buffer;
    vk::vkUpdateDescriptorSets(device, 2, writes, 0, nullptr);
    return set;
  }

  void beginPass(Target& out, VkClearColorValue clear = {}) {
    VkClearValue value{};
    value.color = clear;
    VkRenderPassBeginInfo info{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
    info.renderPass = passes.at(out.format);
    info.framebuffer = out.framebuffer;
    info.renderArea = {{0, 0}, {out.width, out.height}};
    info.clearValueCount = 1;
    info.pClearValues = &value;
    vk::vkCmdBeginRenderPass(cmd, &info, VK_SUBPASS_CONTENTS_INLINE);
  }

  /** Draws `pipeline` into all of `out` (or the `scissor` part of it; the rest is cleared) with `inputs` bound to units 0..3. */
  void pass(Target& out, VkPipeline pipe, std::initializer_list<const Target*> inputs, const void* push, uint32_t pushSize, uint32_t vertices,
            const VkRect2D* scissor = nullptr) {
    VkDescriptorSet set = descriptorSet(inputs, false);
    beginPass(out);
    VkViewport viewport{0, 0, float(out.width), float(out.height), 0, 1};
    vk::vkCmdSetViewport(cmd, 0, 1, &viewport);
    VkRect2D full{{0, 0}, {out.width, out.height}};
    vk::vkCmdSetScissor(cmd, 0, 1, scissor ? scissor : &full);
    vk::vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
    vk::vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, 0, 1, &set, 0, nullptr);
    if (pushSize) vk::vkCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, pushSize, push);
    vk::vkCmdDraw(cmd, vertices, 1, 0, 0);
    vk::vkCmdEndRenderPass(cmd);
  }

  void clearTarget(Target& out) {
    beginPass(out);
    vk::vkCmdEndRenderPass(cmd);
  }

  Target* cleared(uint32_t width, uint32_t height) {
    Target* t = acquire(width, height);
    clearTarget(*t);
    return t;
  }

  void barrier(VkImage image, VkImageLayout from, VkImageLayout to, VkPipelineStageFlags srcStage, VkAccessFlags srcAccess, VkPipelineStageFlags dstStage,
               VkAccessFlags dstAccess) {
    VkImageMemoryBarrier b{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
    b.oldLayout = from;
    b.newLayout = to;
    b.srcAccessMask = srcAccess;
    b.dstAccessMask = dstAccess;
    b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image = image;
    b.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    vk::vkCmdPipelineBarrier(cmd, srcStage, dstStage, 0, 0, nullptr, 0, nullptr, 1, &b);
  }

  // --- compositing (renderer.ts) -----------------------------------------------------------------------------------

  void drawLayerQuad(Target& out, const Target& source, float quadWidth, float quadHeight, float originX, float originY, const float* toView, float zoom) {
    LayerPush p{};
    transpose(toView, p.toView);
    p.layerSize[0] = quadWidth;
    p.layerSize[1] = quadHeight;
    p.origin[0] = originX;
    p.origin[1] = originY;
    p.viewSize[0] = float(out.width);
    p.viewSize[1] = float(out.height);
    p.zoom = zoom;
    pass(out, layerPipe, {&source}, &p, sizeof p, 4);
  }

  Target* renderComp(const Comp& comp, int depth) {
    const uint32_t width = comp.width + 2 * kPad;
    const uint32_t height = comp.height + 2 * kPad;
    Target* accumulated = cleared(width, height);
    for (const Layer& layer : comp.layers) {
      Target* coverage = nullptr;
      Target* placed;
      if (layer.adjustment) {
        coverage = place(layer, width, height, depth);
        placed = accumulated;
      } else {
        placed = place(layer, width, height, depth);
      }
      Target* matteImage = nullptr;
      if (layer.matteMode != matte::None) matteImage = layer.matte ? place(*layer.matte, width, height, depth) : cleared(width, height);
      Target* next = acquire(width, height);
      CompositePush p{};
      p.matteMode = int32_t(matteImage ? layer.matteMode : matte::None);
      p.matteOpacity = layer.matteOpacity;
      p.mode = int32_t(layer.blendMode);
      p.opacity = layer.opacity;
      p.adjust = coverage ? 1 : 0;
      pass(*next, compositePipe, {accumulated, placed, matteImage, coverage}, &p, sizeof p, 3);
      if (placed != accumulated) release(placed);
      release(accumulated);
      release(matteImage);
      release(coverage);
      accumulated = next;
    }
    return accumulated;
  }

  /** The layer's image drawn through its matrix into a new target of the comp image's size. */
  Target* place(const Layer& layer, uint32_t width, uint32_t height, int depth) {
    LayerImage image = layerImage(layer, depth);
    Target* out = cleared(width, height);
    const float k = image.scale;
    drawLayerQuad(*out, *image.target, (float(image.width) + 2 * kPad) / k, (float(image.height) + 2 * kPad) / k, (image.originX - kPad) / k,
                  (image.originY - kPad) / k, layer.matrix.data(), layer.zoom);
    release(image.target);
    return out;
  }

  /** The layer's content in its own pixels, after its masks. */
  LayerImage layerImage(const Layer& layer, int depth) {
    const Content& content = layer.content;
    LayerImage image;
    image.width = content.width;
    image.height = content.height;
    image.originX = content.originX;
    image.originY = content.originY;
    image.scale = content.scale;
    const uint32_t w = content.width + 2 * kPad;
    const uint32_t h = content.height + 2 * kPad;
    switch (content.kind) {
      case ContentKind::Solid: {
        image.target = acquire(w, h);
        beginPass(*image.target);
        VkClearAttachment fill{VK_IMAGE_ASPECT_COLOR_BIT, 0, {}};
        fill.clearValue.color = {{unorm8(content.color[0]), unorm8(content.color[1]), unorm8(content.color[2]), 1}};
        VkClearRect rect{{{kPad, kPad}, {content.width, content.height}}, 0, 1};
        if (content.width && content.height) vk::vkCmdClearAttachments(cmd, 1, &fill, 1, &rect);
        vk::vkCmdEndRenderPass(cmd);
        break;
      }
      case ContentKind::Comp: {
        image.target = renderComp(*content.comp, depth + 1);
        image.width = content.comp->width;
        image.height = content.comp->height;
        break;
      }
      case ContentKind::Image: {
        image.target = upload(plan->images.at(content.image));
        image.width = plan->images[content.image].width;
        image.height = plan->images[content.image].height;
        break;
      }
      case ContentKind::Shape:
        image.target = shapeImage(content, w, h);
        break;
    }
    if (layer.masks.empty()) return image;
    Target* coverage = maskCoverage(layer.masks, *image.target, image);
    Target* out = acquire(image.target->width, image.target->height);
    pass(*out, maskPipe, {image.target, coverage}, nullptr, 0, 3);
    release(image.target);
    release(coverage);
    image.target = out;
    return image;
  }

  /** Straight pixels into a padded premultiplied image. */
  Target* upload(const Image& source) {
    Target* straight = acquire(source.width, source.height);
    const VkDeviceSize bytes = source.pixels.size();
    // The staging buffer is shared: what is recorded so far must have run before it is written.
    flush();
    Buffer& buffer = stagingFor(bytes);
    std::memcpy(buffer.mapped, source.pixels.data(), bytes);
    barrier(straight->image, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0,
            VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT);
    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {source.width, source.height, 1};
    vk::vkCmdCopyBufferToImage(cmd, buffer.buffer, straight->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    barrier(straight->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_PIPELINE_STAGE_TRANSFER_BIT,
            VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT);
    Target* out = acquire(source.width + 2 * kPad, source.height + 2 * kPad);
    const int32_t pad = kPad;
    pass(*out, premultiplyPipe, {straight}, &pad, sizeof pad, 3);
    release(straight);
    // The copy must run before the next upload overwrites the staging buffer.
    flush();
    return out;
  }

  /** A shape layer's paints, bottom first, each laid over the ones below through its coverage (shapes.ts). */
  Target* shapeImage(const Content& content, uint32_t w, uint32_t h) {
    Target* image = cleared(w, h);
    for (const ShapePaint& paint : content.paints) {
      std::vector<ShapePathRef> paths;
      for (const ShapePath& path : paint.paths) paths.push_back({&path.vertices, path.closed});
      const Affine m{paint.matrix[0], paint.matrix[1], paint.matrix[2], paint.matrix[3], paint.matrix[4], paint.matrix[5]};
      const Outline outline = paint.stroke ? strokeOutline(paths, m, paint.width, LineCap(paint.cap), LineJoin(paint.join), paint.miterLimit)
                                           : fillOutline(paths, m);
      if (outline.edges.empty()) continue;
      Target* coverage = acquire(w, h, coverageFormat);
      if (!coveragePass(*coverage, outline, 0, paint.evenOdd)) {
        release(coverage);
        continue;
      }
      PaintPush p{};
      std::copy(paint.color.begin(), paint.color.end(), p.color);
      if (paint.gradient) {
        // Image pixels back to paint space.
        const double det = m[0] * m[3] - m[1] * m[2];
        if (det == 0) {
          release(coverage);
          continue;
        }
        const double ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
        const float toPaintX[4] = {float(ia), float(ic), float(-(ia * m[4] + ic * m[5])), 0};
        const float toPaintY[4] = {float(ib), float(id), float(-(ib * m[4] + id * m[5])), 0};
        std::copy(toPaintX, toPaintX + 4, p.toPaintX);
        std::copy(toPaintY, toPaintY + 4, p.toPaintY);
        const float startEnd[4] = {paint.start[0], paint.start[1], paint.end[0], paint.end[1]};
        std::copy(startEnd, startEnd + 4, p.startEnd);
        p.focus[0] = paint.focus[0];
        p.focus[1] = paint.focus[1];
        p.kind = int32_t(paint.gradient);
        p.rampFirst = writeFloats(paint.ramp);
        p.rampLast = uint32_t(paint.ramp.size() / 4 - 1);
      }
      Target* next = acquire(w, h);
      pass(*next, paintPipe, {image, nullptr, nullptr, coverage}, &p, sizeof p, 3);
      release(image);
      release(coverage);
      image = next;
    }
    return image;
  }

  /**
   * An outline's coverage of each pixel of `out` (zero away from it); false when it covers none. Without expansion the
   * edges go to the shader binned into bands of rows, so a pixel visits only the edges crossing its band.
   */
  bool coveragePass(Target& out, const Outline& outline, float expansion, bool evenOdd) {
    // Pixels farther from the path than its expansion are not covered.
    const float grow = expansion + 2;
    const int32_t x0 = std::clamp(int32_t(std::floor(outline.minX - grow)), 0, int32_t(out.width));
    const int32_t y0 = std::clamp(int32_t(std::floor(outline.minY - grow)), 0, int32_t(out.height));
    const int32_t x1 = std::clamp(int32_t(std::ceil(outline.maxX + grow)), 0, int32_t(out.width));
    const int32_t y1 = std::clamp(int32_t(std::ceil(outline.maxY + grow)), 0, int32_t(out.height));
    if (outline.edges.empty() || x1 <= x0 || y1 <= y0) {
      clearTarget(out);
      return false;
    }
    const VkRect2D scissor{{x0, y0}, {uint32_t(x1 - x0), uint32_t(y1 - y0)}};
    CoveragePush p{0, uint32_t(outline.edges.size()), outline.stroked, expansion, evenOdd ? 1u : 0u, 0, 0, 0};
    if (expansion > 0) {
      p.first = writeEdges(outline);
    } else {
      const uint32_t bands = (uint32_t(y1 - y0) + kBandRows - 1) / kBandRows;
      std::vector<std::vector<Edge>> binned(bands);
      for (const Edge& e : outline.edges) {
        const float top = std::min(e.y0, e.y1), bottom = std::max(e.y0, e.y1);
        if (top == bottom || bottom <= float(y0) || top >= float(y1)) continue;
        const int32_t b0 = std::clamp(int32_t(std::floor((top - float(y0)) / kBandRows)), 0, int32_t(bands) - 1);
        const int32_t b1 = std::clamp(int32_t(std::ceil((bottom - float(y0)) / kBandRows)) - 1, 0, int32_t(bands) - 1);
        for (int32_t b = b0; b <= b1; b++) binned[size_t(b)].push_back(e);
      }
      Outline packed;
      packed.edges.resize(bands);
      for (uint32_t b = 0; b < bands; b++) {
        const uint32_t entry[4] = {uint32_t(packed.edges.size()), uint32_t(binned[b].size()), 0, 0};
        std::memcpy(&packed.edges[b], entry, sizeof entry);
        packed.edges.insert(packed.edges.end(), binned[b].begin(), binned[b].end());
      }
      p.first = writeEdges(packed);
      p.bandRows = kBandRows;
      p.bandTop = float(y0);
      p.bands = bands;
    }
    pass(out, coveragePipe, {}, &p, sizeof p, 3, &scissor);
    return true;
  }

  /** Where in the storage buffer `values` (vec4s) went, in vec4s, after writing them there. */
  uint32_t writeFloats(const std::vector<float>& values) {
    Outline asEdges;
    asEdges.edges.resize(values.size() / 4);
    std::memcpy(asEdges.edges.data(), values.data(), asEdges.edges.size() * sizeof(Edge));
    return writeEdges(asEdges);
  }

  /** Where in the edge buffer `outline` went (in edges), after writing it there. */
  uint32_t writeEdges(const Outline& outline) {
    const VkDeviceSize bytes = outline.edges.size() * sizeof(Edge);
    if (edgesUsed + bytes > edges.size) {
      flush();
      if (bytes > edges.size) {
        destroyBuffer(edges);
        VkDeviceSize size = edges.size ? edges.size : 1 << 16;
        while (size < bytes) size *= 2;
        edges = hostBuffer(size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
      }
    }
    const VkDeviceSize at = edgesUsed;
    if (bytes) std::memcpy(static_cast<uint8_t*>(edges.mapped) + at, outline.edges.data(), bytes);
    edgesUsed = (at + bytes + sizeof(Edge) - 1) / sizeof(Edge) * sizeof(Edge);
    return uint32_t(at / sizeof(Edge));
  }

  /** The masks' combined coverage of a padded layer image (masks.ts), one value per pixel. */
  Target* maskCoverage(const std::vector<Mask>& masks, const Target& target, const LayerImage& image) {
    const uint32_t w = target.width, h = target.height;
    Target* stack = nullptr;
    bool first = true;
    for (const Mask& mask : masks) {
      const Outline outline = flattenPath(mask.vertices, mask.closed, image.scale, kPad - image.originX, kPad - image.originY);
      const float expansion = mask.expansion > 0 ? mask.expansion * image.scale : 0;
      Target* shape = acquire(w, h, coverageFormat);
      coveragePass(*shape, outline, expansion, false);
      Target* coverage = shape;
      if (mask.feather > 0) {
        const int radius = int(std::ceil(mask.feather));
        const double sigma = mask.feather / 2.4;
        double sum = 0;
        for (int i = -radius; i <= radius; i++) sum += std::exp(-(double(i) * i) / (2 * sigma * sigma));
        FeatherPush p{{1, 0}, radius, float(sigma), float(1 / sum)};
        Target* scratch = acquire(w, h, coverageFormat);
        pass(*scratch, featherPipe, {shape}, &p, sizeof p, 3);
        p.step[0] = 0;
        p.step[1] = 1;
        Target* feathered = acquire(w, h, coverageFormat);
        pass(*feathered, featherPipe, {scratch}, &p, sizeof p, 3);
        release(shape);
        release(scratch);
        coverage = feathered;
      }
      // A stack that starts by removing coverage starts from a fully covered layer.
      const bool removes = mask.mode == mask_mode::Subtract || mask.mode == mask_mode::Intersect || mask.mode == mask_mode::Darken;
      CombinePush p{int32_t(mask.mode), first ? 1 : 0, mask.inverted ? 1 : 0, removes ? 1.0f : 0.0f, mask.opacity};
      Target* out = acquire(w, h, coverageFormat);
      pass(*out, combinePipe, {coverage, stack}, &p, sizeof p, 3);
      release(coverage);
      release(stack);
      stack = out;
      first = false;
    }
    return stack;
  }

  // --- frames ------------------------------------------------------------------------------------------------------

  Target* render(const Plan& p) {
    plan = &p;
    begin();
    Target* result = nullptr;
    try {
      result = renderComp(p.root, 0);
      submit();
    } catch (...) {
      if (recording) {
        vk::vkEndCommandBuffer(cmd);
        recording = false;
      }
      plan = nullptr;
      throw;
    }
    plan = nullptr;
    frameNumber++;
    trimPool(options.poolBudget);
    return result;
  }

  void readPixels(const Target& target, std::vector<uint8_t>& rgba) {
    const VkDeviceSize bytes = VkDeviceSize(target.width) * target.height * 4;
    Buffer& buffer = stagingFor(bytes);
    begin();
    barrier(target.image, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
            VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT);
    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {target.width, target.height, 1};
    vk::vkCmdCopyImageToBuffer(cmd, target.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buffer.buffer, 1, &region);
    barrier(target.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_PIPELINE_STAGE_TRANSFER_BIT, 0,
            VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT);
    VkBufferMemoryBarrier host{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};
    host.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    host.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    host.srcQueueFamilyIndex = host.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    host.buffer = buffer.buffer;
    host.size = VK_WHOLE_SIZE;
    vk::vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 0, nullptr, 1, &host, 0, nullptr);
    submit();
    // Premultiplied with the border to straight without it, as Renderer.readPixels returns pixels.
    const uint32_t w = target.width - 2 * kPad, h = target.height - 2 * kPad;
    rgba.resize(size_t(w) * h * 4);
    const auto* src = static_cast<const uint8_t*>(buffer.mapped);
    for (uint32_t y = 0; y < h; y++) {
      const uint8_t* row = src + (size_t(y + kPad) * target.width + kPad) * 4;
      uint8_t* out = rgba.data() + size_t(y) * w * 4;
      for (uint32_t x = 0; x < w * 4; x += 4) {
        const uint32_t a = row[x + 3];
        for (int c = 0; c < 3; c++) out[x + c] = a ? uint8_t(std::min<uint32_t>(255, (row[x + c] * 255u * 2 + a) / (2 * a))) : 0;
        out[x + 3] = uint8_t(a);
      }
    }
  }

  // --- presentation ------------------------------------------------------------------------------------------------

  void destroySwapchain(bool keepSurface) {
    if (!device) return;
    vk::vkDeviceWaitIdle(device);
    for (VkFramebuffer fb : swap.framebuffers) vk::vkDestroyFramebuffer(device, fb, nullptr);
    for (VkImageView v : swap.views) vk::vkDestroyImageView(device, v, nullptr);
    swap.framebuffers.clear();
    swap.views.clear();
    swap.images.clear();
    if (swap.swapchain) vk::vkDestroySwapchainKHR(device, swap.swapchain, nullptr);
    swap.swapchain = VK_NULL_HANDLE;
    if (keepSurface) return;
    if (swap.pipeline) vk::vkDestroyPipeline(device, swap.pipeline, nullptr);
    if (swap.pass) vk::vkDestroyRenderPass(device, swap.pass, nullptr);
    if (swap.acquired) vk::vkDestroySemaphore(device, swap.acquired, nullptr);
    if (swap.rendered) vk::vkDestroySemaphore(device, swap.rendered, nullptr);
    if (swap.surface) vk::vkDestroySurfaceKHR(instance, swap.surface, nullptr);
#if defined(__ANDROID__)
    if (swap.window) ANativeWindow_release(swap.window);
#endif
    swap = Swapchain();
  }

  void createSwapchain() {
    VkSurfaceCapabilitiesKHR caps;
    AEVK_CHECK(vk::vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physical, swap.surface, &caps));
    if (swap.format == VK_FORMAT_UNDEFINED) {
      uint32_t count = 0;
      vk::vkGetPhysicalDeviceSurfaceFormatsKHR(physical, swap.surface, &count, nullptr);
      std::vector<VkSurfaceFormatKHR> formats(count);
      vk::vkGetPhysicalDeviceSurfaceFormatsKHR(physical, swap.surface, &count, formats.data());
      if (formats.empty()) throw std::runtime_error("the window offers no pixel format");
      swap.format = formats[0].format;
      for (const VkSurfaceFormatKHR& f : formats)
        if (f.format == VK_FORMAT_R8G8B8A8_UNORM || f.format == VK_FORMAT_B8G8R8A8_UNORM) swap.format = f.format;
      swap.pass = renderPass(swap.format, VK_IMAGE_LAYOUT_PRESENT_SRC_KHR);
      swap.pipeline = pipeline(layerVert, layerFrag, swap.pass, true);
      VkSemaphoreCreateInfo semaphore{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
      AEVK_CHECK(vk::vkCreateSemaphore(device, &semaphore, nullptr, &swap.acquired));
      AEVK_CHECK(vk::vkCreateSemaphore(device, &semaphore, nullptr, &swap.rendered));
    }
    swap.extent = caps.currentExtent;
    if (swap.extent.width == UINT32_MAX) swap.extent = caps.minImageExtent;
    VkSwapchainCreateInfoKHR create{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
    create.surface = swap.surface;
    create.minImageCount = std::max(caps.minImageCount, 2u);
    if (caps.maxImageCount) create.minImageCount = std::min(create.minImageCount, caps.maxImageCount);
    create.imageFormat = swap.format;
    create.imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
    create.imageExtent = swap.extent;
    create.imageArrayLayers = 1;
    create.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    create.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    create.preTransform = caps.currentTransform;
    create.compositeAlpha = (caps.supportedCompositeAlpha & VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR) ? VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR : VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR;
    create.presentMode = VK_PRESENT_MODE_FIFO_KHR;
    create.clipped = VK_TRUE;
    AEVK_CHECK(vk::vkCreateSwapchainKHR(device, &create, nullptr, &swap.swapchain));
    uint32_t count = 0;
    vk::vkGetSwapchainImagesKHR(device, swap.swapchain, &count, nullptr);
    swap.images.resize(count);
    vk::vkGetSwapchainImagesKHR(device, swap.swapchain, &count, swap.images.data());
    for (VkImage image : swap.images) {
      VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
      view.image = image;
      view.viewType = VK_IMAGE_VIEW_TYPE_2D;
      view.format = swap.format;
      view.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
      VkImageView v;
      AEVK_CHECK(vk::vkCreateImageView(device, &view, nullptr, &v));
      swap.views.push_back(v);
      VkFramebufferCreateInfo fb{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
      fb.renderPass = swap.pass;
      fb.attachmentCount = 1;
      fb.pAttachments = &v;
      fb.width = swap.extent.width;
      fb.height = swap.extent.height;
      fb.layers = 1;
      VkFramebuffer f;
      AEVK_CHECK(vk::vkCreateFramebuffer(device, &fb, nullptr, &f));
      swap.framebuffers.push_back(f);
    }
  }

  /** Draws a frame into the window, fitted into `rect` as Renderer.present fits a comp into its canvas. */
  void present(const Target& frame, const PresentRect& rect, const float background[3]) {
    if (!swap.surface) throw std::runtime_error("no window is attached");
    if (!swap.swapchain) createSwapchain();
    uint32_t index = 0;
    VkResult acquired = vk::vkAcquireNextImageKHR(device, swap.swapchain, UINT64_MAX, swap.acquired, VK_NULL_HANDLE, &index);
    if (acquired == VK_ERROR_OUT_OF_DATE_KHR) {
      destroySwapchain(true);
      createSwapchain();
      acquired = vk::vkAcquireNextImageKHR(device, swap.swapchain, UINT64_MAX, swap.acquired, VK_NULL_HANDLE, &index);
    }
    if (acquired != VK_SUCCESS && acquired != VK_SUBOPTIMAL_KHR) throw VkFailure("vkAcquireNextImageKHR", acquired);
    const float viewW = float(swap.extent.width), viewH = float(swap.extent.height);
    const float boxX = rect.width > 0 ? rect.x : 0, boxY = rect.height > 0 ? rect.y : 0;
    const float boxW = rect.width > 0 ? rect.width : viewW, boxH = rect.height > 0 ? rect.height : viewH;
    const float contentW = float(frame.width - 2 * kPad), contentH = float(frame.height - 2 * kPad);
    const float s = std::min(boxW / contentW, boxH / contentH);
    const float tx = boxX + (boxW - contentW * s) / 2 - kPad * s, ty = boxY + (boxH - contentH * s) / 2 - kPad * s;
    const float toView[16] = {s, 0, 0, tx, 0, s, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1};
    LayerPush p{};
    transpose(toView, p.toView);
    p.layerSize[0] = float(frame.width);
    p.layerSize[1] = float(frame.height);
    p.viewSize[0] = viewW;
    p.viewSize[1] = viewH;
    begin();
    VkDescriptorSet set = descriptorSet({&frame}, false);
    VkClearValue clear{};
    clear.color = {{background[0], background[1], background[2], 1}};
    VkRenderPassBeginInfo info{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
    info.renderPass = swap.pass;
    info.framebuffer = swap.framebuffers[index];
    info.renderArea = {{0, 0}, swap.extent};
    info.clearValueCount = 1;
    info.pClearValues = &clear;
    vk::vkCmdBeginRenderPass(cmd, &info, VK_SUBPASS_CONTENTS_INLINE);
    VkViewport viewport{0, 0, viewW, viewH, 0, 1};
    VkRect2D scissor{{0, 0}, swap.extent};
    vk::vkCmdSetViewport(cmd, 0, 1, &viewport);
    vk::vkCmdSetScissor(cmd, 0, 1, &scissor);
    vk::vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, swap.pipeline);
    vk::vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, 0, 1, &set, 0, nullptr);
    vk::vkCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof p, &p);
    vk::vkCmdDraw(cmd, 4, 1, 0, 0);
    vk::vkCmdEndRenderPass(cmd);
    submit(swap.acquired, swap.rendered);
    VkPresentInfoKHR presentInfo{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
    presentInfo.waitSemaphoreCount = 1;
    presentInfo.pWaitSemaphores = &swap.rendered;
    presentInfo.swapchainCount = 1;
    presentInfo.pSwapchains = &swap.swapchain;
    presentInfo.pImageIndices = &index;
    VkResult shown = vk::vkQueuePresentKHR(queue, &presentInfo);
    if (shown == VK_ERROR_OUT_OF_DATE_KHR || shown == VK_SUBOPTIMAL_KHR) destroySwapchain(true);
    else if (shown != VK_SUCCESS) throw VkFailure("vkQueuePresentKHR", shown);
  }

  // --- teardown ----------------------------------------------------------------------------------------------------

  void destroy() {
    if (device) {
      vk::vkDeviceWaitIdle(device);
      destroySwapchain(false);
      for (auto& [key, list] : free)
        for (Target* t : list) destroyTarget(t);
      free.clear();
      if (dummy) destroyTarget(dummy);
      dummy = nullptr;
      destroyBuffer(edges);
      destroyBuffer(staging);
      for (VkPipeline p : {layerPipe, compositePipe, maskPipe, premultiplyPipe, coveragePipe, featherPipe, combinePipe, paintPipe})
        if (p) vk::vkDestroyPipeline(device, p, nullptr);
      for (VkShaderModule m : modules) vk::vkDestroyShaderModule(device, m, nullptr);
      for (auto& [format, pass] : passes) vk::vkDestroyRenderPass(device, pass, nullptr);
      if (linear) vk::vkDestroySampler(device, linear, nullptr);
      if (nearest) vk::vkDestroySampler(device, nearest, nullptr);
      if (descriptorPool) vk::vkDestroyDescriptorPool(device, descriptorPool, nullptr);
      if (pipelineLayout) vk::vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
      if (setLayout) vk::vkDestroyDescriptorSetLayout(device, setLayout, nullptr);
      if (fence) vk::vkDestroyFence(device, fence, nullptr);
      if (commandPool) vk::vkDestroyCommandPool(device, commandPool, nullptr);
      vk::vkDestroyDevice(device, nullptr);
      device = VK_NULL_HANDLE;
    }
    if (instance) vk::vkDestroyInstance(instance, nullptr);
    instance = VK_NULL_HANDLE;
  }
};

// --- public API --------------------------------------------------------------------------------------------------

Frame::~Frame() {
  if (state_ && state_->impl) state_->impl->release(state_->target);
}
uint32_t Frame::width() const { return state_->target->width; }
uint32_t Frame::height() const { return state_->target->height; }
size_t Frame::bytes() const { return state_->target->bytes; }

Engine::Engine(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Engine::~Engine() = default;

std::unique_ptr<Engine> Engine::create(const EngineOptions& options, std::string& error) {
  auto impl = std::make_unique<Impl>();
  impl->options = options;
  try {
    impl->init();
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
  return std::unique_ptr<Engine>(new Engine(std::move(impl)));
}

const DeviceInfo& Engine::device() const { return impl_->info; }

std::shared_ptr<Frame> Engine::renderFrame(const Plan& plan, std::string& error) {
  try {
    Target* target = impl_->render(plan);
    auto frame = std::shared_ptr<Frame>(new Frame());
    frame->state_ = std::make_unique<Frame::State>();
    frame->state_->impl = impl_.get();
    frame->state_->target = target;
    return frame;
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

bool Engine::readPixels(const Frame& frame, std::vector<uint8_t>& rgba, std::string& error) {
  try {
    impl_->readPixels(*frame.state_->target, rgba);
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

bool Engine::render(const Plan& plan, std::vector<uint8_t>& rgba, uint32_t& width, uint32_t& height, std::string& error) {
  std::shared_ptr<Frame> frame = renderFrame(plan, error);
  if (!frame) return false;
  width = frame->width() - 2 * kPad;
  height = frame->height() - 2 * kPad;
  return readPixels(*frame, rgba, error);
}

#if defined(__ANDROID__)
bool Engine::attachWindow(ANativeWindow* window, std::string& error) {
  try {
    impl_->destroySwapchain(false);
    if (!impl_->swapchainExtension || !vk::vkCreateAndroidSurfaceKHR) throw std::runtime_error("this device cannot present Vulkan frames to a window");
    VkAndroidSurfaceCreateInfoKHR create{VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR};
    create.window = window;
    AEVK_CHECK(vk::vkCreateAndroidSurfaceKHR(impl_->instance, &create, nullptr, &impl_->swap.surface));
    ANativeWindow_acquire(window);
    impl_->swap.window = window;
    VkBool32 supported = VK_FALSE;
    vk::vkGetPhysicalDeviceSurfaceSupportKHR(impl_->physical, impl_->queueFamily, impl_->swap.surface, &supported);
    if (!supported) throw std::runtime_error("the rendering queue cannot present to this window");
    return true;
  } catch (const std::exception& e) {
    impl_->destroySwapchain(false);
    error = e.what();
    return false;
  }
}

void Engine::detachWindow() { impl_->destroySwapchain(false); }
#endif

bool Engine::hasWindow() const { return impl_->swap.surface != VK_NULL_HANDLE; }

bool Engine::present(const Frame& frame, const PresentRect& rect, const float background[3], std::string& error) {
  try {
    impl_->present(*frame.state_->target, rect, background);
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

void Engine::trim(size_t bytes) { impl_->trimPool(bytes); }
size_t Engine::pooledBytes() const { return impl_->freeBytes; }

}  // namespace aevk
