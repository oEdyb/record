// swift-tools-version: 5.9

import Foundation
import PackageDescription

let supportDirectory = URL(fileURLWithPath: #filePath)
	.deletingLastPathComponent()
	.appendingPathComponent("Support")
	.path

// codesign takes a bare executable's identifier from its embedded __TEXT,__info_plist section,
// so each helper carries its own co.dyberg.klippt.* bundle identifier.
func embeddedInfoPlist(_ name: String) -> [LinkerSetting] {
	[
		.unsafeFlags([
			"-Xlinker", "-sectcreate",
			"-Xlinker", "__TEXT",
			"-Xlinker", "__info_plist",
			"-Xlinker", "\(supportDirectory)/\(name)-Info.plist",
		])
	]
}

let package = Package(
	name: "OpenScreenScreenCaptureKitHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "klippt-screencapturekit-helper",
			targets: ["OpenScreenScreenCaptureKitHelper"]
		),
		.executable(
			name: "klippt-cursor-helper",
			targets: ["OpenScreenMacOSCursorHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "OpenScreenScreenCaptureKitHelper",
			path: "Sources/OpenScreenScreenCaptureKitHelper",
			linkerSettings: embeddedInfoPlist("screencapturekit-helper")
		),
		.executableTarget(
			name: "OpenScreenMacOSCursorHelper",
			path: "Sources/OpenScreenMacOSCursorHelper",
			linkerSettings: embeddedInfoPlist("cursor-helper")
		)
	]
)
