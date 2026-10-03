import AVFoundation
import CoreVideo
import Foundation

// Reproduce ScreenCaptureKit's 600-tick variable-rate AVAssetWriter timeline,
// including the closely spaced final closing sample. No capture permission or
// application helper is used; this is deterministic test media only.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: 160,
    AVVideoHeightKey: 90,
    AVVideoCompressionPropertiesKey: [
        AVVideoExpectedSourceFrameRateKey: 60,
        AVVideoAllowFrameReorderingKey: false,
        AVVideoMaxKeyFrameIntervalKey: 120,
        AVVideoAverageBitRateKey: 500_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    ],
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
    sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
writer.add(input)
guard writer.startWriting() else { throw writer.error ?? NSError(domain: "Fixture", code: 1) }
writer.startSession(atSourceTime: .zero)
var lastTime = CMTime.zero
for index in 0...120 {
    let deadline = Date().addingTimeInterval(10)
    while !input.isReadyForMoreMediaData && Date() < deadline { Thread.sleep(forTimeInterval: 0.001) }
    guard input.isReadyForMoreMediaData else { throw writer.error ?? NSError(domain: "Fixture", code: 2) }
    var buffer: CVPixelBuffer?
    let result = CVPixelBufferCreate(kCFAllocatorDefault, 160, 90, kCVPixelFormatType_32BGRA, nil, &buffer)
    guard result == kCVReturnSuccess, let buffer else { throw NSError(domain: "Fixture", code: 3) }
    CVPixelBufferLockBaseAddress(buffer, [])
    memset(CVPixelBufferGetBaseAddress(buffer), Int32(min(index, 119) % 255), CVPixelBufferGetBytesPerRow(buffer) * 90)
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let jitter = [0, 3, -2, 1, 0, -3][index % 6]
    let ticks = index == 120 ? lastTime.value + 1 : Int64((Double(index) * 600 / 58).rounded()) + Int64(jitter)
    lastTime = CMTime(value: ticks, timescale: 600)
    guard adaptor.append(buffer, withPresentationTime: lastTime) else { throw writer.error ?? NSError(domain: "Fixture", code: 4) }
}
writer.endSession(atSourceTime: lastTime)
input.markAsFinished()
let completion = DispatchSemaphore(value: 0)
writer.finishWriting { completion.signal() }
guard completion.wait(timeout: .now() + 10) == .success, writer.status == .completed else {
    throw writer.error ?? NSError(domain: "Fixture", code: 5)
}
