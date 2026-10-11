// Vulkan entry points, loaded at run time from the system's loader (libvulkan.so / vulkan-1.dll), so the engine links
// against nothing Vulkan-specific and a device without Vulkan reports that instead of failing to load.
#pragma once

#ifndef VK_NO_PROTOTYPES
#define VK_NO_PROTOTYPES
#endif
#if defined(__ANDROID__) && !defined(VK_USE_PLATFORM_ANDROID_KHR)
#define VK_USE_PLATFORM_ANDROID_KHR
#endif
#include <vulkan/vulkan.h>

#define AEVK_GLOBAL_FUNCTIONS(X) \
  X(vkCreateInstance)            \
  X(vkEnumerateInstanceExtensionProperties)

#define AEVK_INSTANCE_FUNCTIONS(X)                \
  X(vkDestroyInstance)                            \
  X(vkEnumeratePhysicalDevices)                   \
  X(vkGetPhysicalDeviceProperties)                \
  X(vkGetPhysicalDeviceQueueFamilyProperties)     \
  X(vkGetPhysicalDeviceMemoryProperties)          \
  X(vkGetPhysicalDeviceFormatProperties)          \
  X(vkEnumerateDeviceExtensionProperties)         \
  X(vkCreateDevice)                               \
  X(vkGetDeviceProcAddr)                          \
  X(vkDestroySurfaceKHR)                          \
  X(vkGetPhysicalDeviceSurfaceSupportKHR)         \
  X(vkGetPhysicalDeviceSurfaceCapabilitiesKHR)    \
  X(vkGetPhysicalDeviceSurfaceFormatsKHR)

#if defined(__ANDROID__)
#define AEVK_PLATFORM_INSTANCE_FUNCTIONS(X) X(vkCreateAndroidSurfaceKHR)
#else
#define AEVK_PLATFORM_INSTANCE_FUNCTIONS(X)
#endif

#define AEVK_DEVICE_FUNCTIONS(X)       \
  X(vkDestroyDevice)                   \
  X(vkGetDeviceQueue)                  \
  X(vkDeviceWaitIdle)                  \
  X(vkQueueSubmit)                     \
  X(vkQueueWaitIdle)                   \
  X(vkCreateCommandPool)               \
  X(vkDestroyCommandPool)              \
  X(vkAllocateCommandBuffers)          \
  X(vkResetCommandBuffer)              \
  X(vkBeginCommandBuffer)              \
  X(vkEndCommandBuffer)                \
  X(vkCreateFence)                     \
  X(vkDestroyFence)                    \
  X(vkWaitForFences)                   \
  X(vkResetFences)                     \
  X(vkCreateSemaphore)                 \
  X(vkDestroySemaphore)                \
  X(vkAllocateMemory)                  \
  X(vkFreeMemory)                      \
  X(vkMapMemory)                       \
  X(vkUnmapMemory)                     \
  X(vkCreateBuffer)                    \
  X(vkDestroyBuffer)                   \
  X(vkGetBufferMemoryRequirements)     \
  X(vkBindBufferMemory)                \
  X(vkCreateImage)                     \
  X(vkDestroyImage)                    \
  X(vkGetImageMemoryRequirements)      \
  X(vkBindImageMemory)                 \
  X(vkCreateImageView)                 \
  X(vkDestroyImageView)                \
  X(vkCreateSampler)                   \
  X(vkDestroySampler)                  \
  X(vkCreateRenderPass)                \
  X(vkDestroyRenderPass)               \
  X(vkCreateFramebuffer)               \
  X(vkDestroyFramebuffer)              \
  X(vkCreateShaderModule)              \
  X(vkDestroyShaderModule)             \
  X(vkCreateDescriptorSetLayout)       \
  X(vkDestroyDescriptorSetLayout)      \
  X(vkCreatePipelineLayout)            \
  X(vkDestroyPipelineLayout)           \
  X(vkCreateGraphicsPipelines)         \
  X(vkDestroyPipeline)                 \
  X(vkCreateDescriptorPool)            \
  X(vkDestroyDescriptorPool)           \
  X(vkResetDescriptorPool)             \
  X(vkAllocateDescriptorSets)          \
  X(vkUpdateDescriptorSets)            \
  X(vkCmdBeginRenderPass)              \
  X(vkCmdEndRenderPass)                \
  X(vkCmdBindPipeline)                 \
  X(vkCmdBindDescriptorSets)           \
  X(vkCmdPushConstants)                \
  X(vkCmdSetViewport)                  \
  X(vkCmdSetScissor)                   \
  X(vkCmdDraw)                         \
  X(vkCmdClearAttachments)             \
  X(vkCmdPipelineBarrier)              \
  X(vkCmdCopyBufferToImage)            \
  X(vkCmdCopyImageToBuffer)            \
  X(vkCreateSwapchainKHR)              \
  X(vkDestroySwapchainKHR)             \
  X(vkGetSwapchainImagesKHR)           \
  X(vkAcquireNextImageKHR)             \
  X(vkQueuePresentKHR)

namespace aevk::vk {

#define AEVK_DECLARE(name) extern PFN_##name name;
AEVK_GLOBAL_FUNCTIONS(AEVK_DECLARE)
AEVK_INSTANCE_FUNCTIONS(AEVK_DECLARE)
AEVK_PLATFORM_INSTANCE_FUNCTIONS(AEVK_DECLARE)
AEVK_DEVICE_FUNCTIONS(AEVK_DECLARE)
#undef AEVK_DECLARE

/** Opens the system's Vulkan loader; false (with `error` set) when there is none. */
bool loadLibrary(const char** error);
void loadInstance(VkInstance instance);
void loadDevice(VkDevice device);

}  // namespace aevk::vk
