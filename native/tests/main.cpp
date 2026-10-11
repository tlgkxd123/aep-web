#include <cstdio>

#include "check.h"

namespace aevk::test {
std::vector<Case>& cases() {
  static std::vector<Case> all;
  return all;
}
int failures = 0;
std::string skipped;
}  // namespace aevk::test

int main() {
  using namespace aevk::test;
  int skips = 0;
  for (const Case& c : cases()) {
    const int before = failures;
    skipped.clear();
    c.run();
    if (!skipped.empty()) {
      skips++;
      std::printf("skip %s: %s\n", c.name, skipped.c_str());
    } else {
      std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", c.name);
    }
  }
  std::printf("%zu cases, %d failed checks, %d skipped\n", cases().size(), failures, skips);
  return failures ? 1 : 0;
}
