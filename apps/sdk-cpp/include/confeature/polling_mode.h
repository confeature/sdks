// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_POLLING_MODE_H_
#define CONFEATURE_POLLING_MODE_H_

// `PollingMode` mirrors ConfigCat-cpp's polling-mode tagged union. v0.1
// surfaces the three canonical variants (`AutoPoll`, `LazyLoad`,
// `ManualPoll`); the polling-service implementation lives in
// internal/poll_service (deferred to a follow-up — v0.1 fetches on
// startup + force-refresh only).

#include <chrono>

namespace confeature {

class PollingMode {
 public:
  enum class Kind { AutoPoll, LazyLoad, ManualPoll };

  static PollingMode autoPoll(std::chrono::seconds interval = std::chrono::seconds(60),
                              std::chrono::seconds maxInitWait = std::chrono::seconds(5)) {
    PollingMode m;
    m.kind_ = Kind::AutoPoll;
    m.interval_ = interval;
    m.maxInitWait_ = maxInitWait;
    return m;
  }

  static PollingMode lazyLoad(std::chrono::seconds cacheTtl = std::chrono::seconds(60)) {
    PollingMode m;
    m.kind_ = Kind::LazyLoad;
    m.interval_ = cacheTtl;
    return m;
  }

  static PollingMode manualPoll() {
    PollingMode m;
    m.kind_ = Kind::ManualPoll;
    return m;
  }

  Kind kind() const { return kind_; }
  std::chrono::seconds interval() const { return interval_; }
  std::chrono::seconds maxInitWait() const { return maxInitWait_; }

 private:
  PollingMode() = default;

  Kind kind_{Kind::AutoPoll};
  std::chrono::seconds interval_{60};
  std::chrono::seconds maxInitWait_{5};
};

}  // namespace confeature

#endif  // CONFEATURE_POLLING_MODE_H_
