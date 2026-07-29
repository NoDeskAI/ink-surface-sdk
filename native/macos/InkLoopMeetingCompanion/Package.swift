// swift-tools-version: 6.1

import PackageDescription

let package = Package(
  name: "InkLoopMeetingCompanion",
  platforms: [
    // MenuBarExtra requires macOS 13. Phase 0 may raise this provisional
    // build floor after real Meet/Zoom capture experiments.
    .macOS(.v13)
  ],
  products: [
    .library(name: "InkLoopMeetingAdapter", targets: ["InkLoopMeetingAdapter"]),
    .executable(name: "InkLoopMeetingCompanion", targets: ["InkLoopMeetingCompanionApp"]),
  ],
  targets: [
    .target(name: "InkLoopMeetingAdapter"),
    .executableTarget(
      name: "InkLoopMeetingCompanionApp",
      dependencies: ["InkLoopMeetingAdapter"]
    ),
    .testTarget(
      name: "InkLoopMeetingAdapterTests",
      dependencies: ["InkLoopMeetingAdapter"]
    ),
  ]
)
