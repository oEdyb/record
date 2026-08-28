// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "KlipptParakeetSTT",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "klippt-parakeet-stt", targets: ["KlipptParakeetSTT"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.15.6"
        ),
    ],
    targets: [
        .executableTarget(
            name: "KlipptParakeetSTT",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
