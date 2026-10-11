// A minimal test runner: TEST(name) { CHECK(...); } registers a case; main runs them all.
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace aevk::test {

struct Case {
  const char* name;
  std::function<void()> run;
};

std::vector<Case>& cases();
extern int failures;
/** Set by a case that cannot run here (no Vulkan device); it is reported as skipped. */
extern std::string skipped;

struct Register {
  Register(const char* name, std::function<void()> run) { cases().push_back({name, std::move(run)}); }
};

}  // namespace aevk::test

#define AEVK_JOIN2(a, b) a##b
#define AEVK_JOIN(a, b) AEVK_JOIN2(a, b)
#define TEST(name)                                                                       \
  static void AEVK_JOIN(test_, name)();                                                  \
  static ::aevk::test::Register AEVK_JOIN(register_, name)(#name, AEVK_JOIN(test_, name)); \
  static void AEVK_JOIN(test_, name)()

#define CHECK(condition)                                                          \
  do {                                                                            \
    if (!(condition)) {                                                           \
      ::aevk::test::failures++;                                                   \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);          \
    }                                                                             \
  } while (0)

#define CHECK_NEAR(a, b, tolerance)                                                                                     \
  do {                                                                                                                  \
    const double a_ = (a), b_ = (b);                                                                                    \
    if (!(std::abs(a_ - b_) <= (tolerance))) {                                                                          \
      ::aevk::test::failures++;                                                                                         \
      std::printf("  FAIL %s:%d: %s = %.9g, expected %s = %.9g\n", __FILE__, __LINE__, #a, a_, #b, b_);                 \
    }                                                                                                                   \
  } while (0)

#define SKIP(reason)                     \
  do {                                   \
    ::aevk::test::skipped = (reason);    \
    return;                              \
  } while (0)
