import CoreML
import FluidAudio
import Foundation

// Forced word alignment with a CTC character model (torchaudio WAV2VEC2_ASR_BASE_960H, converted to
// Core ML by scripts/convert-wav2vec2-coreml.py). A port of retake-cutter's align.py:
// per window of speech, force the known letters through the CTC emissions with Viterbi, merge the
// path into token spans, and map spans back to words. Words the 29-symbol vocabulary cannot spell
// keep the recognizer's times.

struct AlignWordInput: Decodable {
    let word: String
    let startSec: Double
    let endSec: Double
}

struct AlignedWordOutput: Encodable {
    let startSec: Double
    let endSec: Double
    let aligned: Bool
}

struct AlignerLabels: Decodable {
    let labels: [String]
    let blank: Int
    let separator: String
    let sampleRate: Int
    let minSamples: Int
    let maxSamples: Int
    let input: String?
    let output: String?
}

enum AlignerError: LocalizedError {
    case missingModel(String)
    case badOutput(String)

    var errorDescription: String? {
        switch self {
        case .missingModel(let path):
            return "The aligner model is missing at \(path)."
        case .badOutput(let detail):
            return "The aligner model returned an unexpected output: \(detail)."
        }
    }
}

// MARK: - Windowing (align.py `_windows`)

enum AlignerConstants {
    static let windowMax = 20.0  // seconds of speech per alignment window
    static let windowGap = 1.0  // a silence this long closes a window
    static let margin = 0.4  // audio kept around each window
    static let minChunkSeconds = 0.1
    static let minimumWordSeconds = 0.02
}

/// Groups word indices into windows of speech: a gap over `windowGap` closes a window, and so
/// does a window that would span more than `windowMax` seconds. Same test as the Python reference
/// (gap measured from the previous word's end, span from the window's first start).
func alignmentWindows(_ words: [AlignWordInput]) -> [[Int]] {
    var out: [[Int]] = []
    for (i, word) in words.enumerated() {
        if let current = out.last, let first = current.first, let last = current.last,
            word.startSec - words[last].endSec <= AlignerConstants.windowGap,
            word.endSec - words[first].startSec <= AlignerConstants.windowMax
        {
            out[out.count - 1].append(i)
        } else {
            out.append([i])
        }
    }
    return out
}

/// `re.sub(r"[^A-Z']", "", word.upper())`
func alignmentLetters(_ word: String) -> [Character] {
    word.uppercased().unicodeScalars.compactMap { scalar in
        let v = scalar.value
        if (v >= 0x41 && v <= 0x5A) || v == 0x27 { return Character(scalar) }
        return nil
    }
}

// MARK: - CTC forced alignment (torchaudio.functional.forced_align + merge_tokens)

struct TokenSpan {
    let token: Int
    let start: Int  // inclusive frame
    let end: Int  // exclusive frame
}

/// Viterbi forced alignment of `targets` (no blanks) to `logProbs` (frames x classes, row-major),
/// ported from torchaudio's CPU `forced_align`: the same trellis (blank, t0, blank, t1, ...), the
/// same transition rules (skip over a blank only between different labels) and the same tie
/// breaking (a longer jump wins only when strictly better). Returns the label per frame, or nil
/// when the emission is too short (`frames < labels + repeats`).
func ctcForcedAlign(
    logProbs: UnsafeBufferPointer<Float>,
    frames T: Int,
    classes C: Int,
    targets: [Int],
    blank: Int
) -> [Int]? {
    let L = targets.count
    guard L > 0, T > 0 else { return nil }
    var repeats = 0
    for i in 1..<max(L, 1) where targets[i] == targets[i - 1] { repeats += 1 }
    guard T >= L + repeats else { return nil }

    let S = 2 * L + 1
    let negInf = -Float.infinity
    var prev = [Float](repeating: negInf, count: S)
    var curr = [Float](repeating: negInf, count: S)
    var backPtr = [UInt8](repeating: 0, count: T * S)

    @inline(__always) func label(_ i: Int) -> Int { i % 2 == 0 ? blank : targets[i / 2] }

    // t = 0: only the leading blank or the first label are reachable. When the emission has no
    // slack the leading blank is excluded (torchaudio: start = T - (L + R) > 0 ? 0 : 1).
    let start0 = T - (L + repeats) > 0 ? 0 : 1
    let end0 = S == 1 ? 1 : 2
    for i in start0..<end0 { prev[i] = logProbs[label(i)] }

    for t in 1..<max(T, 1) {
        let row = t * C
        for i in 0..<S {
            let x0 = prev[i]
            let x1 = i > 0 ? prev[i - 1] : negInf
            var x2 = negInf
            if i % 2 != 0, i != 1, targets[i / 2] != targets[i / 2 - 1] { x2 = prev[i - 2] }
            var result: Float
            var ptr: UInt8
            if x2 > x1, x2 > x0 {
                result = x2
                ptr = 2
            } else if x1 > x0, x1 > x2 {
                result = x1
                ptr = 1
            } else {
                result = x0
                ptr = 0
            }
            curr[i] = result == negInf ? negInf : result + logProbs[row + label(i)]
            backPtr[t * S + i] = ptr
        }
        swap(&prev, &curr)
    }

    var state: Int
    if S == 1 {
        state = 0
    } else {
        state = prev[S - 1] > prev[S - 2] ? S - 1 : S - 2
    }
    guard prev[state] > negInf else { return nil }
    var path = [Int](repeating: blank, count: T)
    var t = T - 1
    while t >= 0 {
        path[t] = label(state)
        state -= Int(backPtr[t * S + state])
        t -= 1
    }
    return path
}

/// torchaudio `merge_tokens`: drop blanks and collapse runs of the same token into spans.
func mergeTokens(_ path: [Int], blank: Int) -> [TokenSpan] {
    var spans: [TokenSpan] = []
    var start = 0
    for t in 1...path.count {
        if t == path.count || path[t] != path[start] {
            if path[start] != blank { spans.append(TokenSpan(token: path[start], start: start, end: t)) }
            start = t
        }
    }
    return spans
}

// MARK: - Core ML model

final class Wav2Vec2Emitter: @unchecked Sendable {
    let labels: AlignerLabels
    private let model: MLModel

    static let packageName = "wav2vec2-base-960h.mlpackage"
    static let compiledName = "wav2vec2-base-960h.mlmodelc"

    init(directory: URL) throws {
        let labelsURL = directory.appendingPathComponent("labels.json")
        guard FileManager.default.fileExists(atPath: labelsURL.path) else {
            throw AlignerError.missingModel(labelsURL.path)
        }
        labels = try JSONDecoder().decode(AlignerLabels.self, from: Data(contentsOf: labelsURL))

        let compiled = directory.appendingPathComponent(Self.compiledName)
        let package = directory.appendingPathComponent(Self.packageName)
        var modelURL: URL
        if FileManager.default.fileExists(atPath: compiled.path) {
            modelURL = compiled
        } else if FileManager.default.fileExists(atPath: package.path) {
            let temporary = try MLModel.compileModel(at: package)
            // Keep the compiled model next to the package so later launches skip compiling.
            do {
                try FileManager.default.moveItem(at: temporary, to: compiled)
                modelURL = compiled
            } catch {
                modelURL = temporary
            }
        } else {
            throw AlignerError.missingModel(package.path)
        }
        let configuration = MLModelConfiguration()
        // The Neural Engine compiler stalls on flexible-length models; CPU and GPU are fast enough.
        configuration.computeUnits = .cpuAndGPU
        model = try MLModel(contentsOf: modelURL, configuration: configuration)
    }

    /// Log-softmax emissions for 16 kHz mono samples: row-major [frames x classes].
    func emissions(for samples: ArraySlice<Float>) throws -> (values: [Float], frames: Int) {
        let n = samples.count
        let input = try MLMultiArray(shape: [1, NSNumber(value: n)], dataType: .float32)
        samples.withUnsafeBufferPointer { source in
            input.dataPointer.copyMemory(from: source.baseAddress!, byteCount: n * MemoryLayout<Float>.stride)
        }
        let features = try MLDictionaryFeatureProvider(dictionary: [labels.input ?? "audio": MLFeatureValue(multiArray: input)])
        let output = try model.prediction(from: features)
        guard let emission = output.featureValue(for: labels.output ?? "emission")?.multiArrayValue else {
            throw AlignerError.badOutput("no emission array")
        }
        guard emission.shape.count == 3, emission.shape[2].intValue == labels.labels.count else {
            throw AlignerError.badOutput("shape \(emission.shape)")
        }
        let frames = emission.shape[1].intValue
        let classes = emission.shape[2].intValue
        let strideT = emission.strides[1].intValue
        let strideC = emission.strides[2].intValue
        var values = [Float](repeating: 0, count: frames * classes)
        switch emission.dataType {
        case .float32:
            let pointer = emission.dataPointer.assumingMemoryBound(to: Float.self)
            for t in 0..<frames {
                for c in 0..<classes { values[t * classes + c] = pointer[t * strideT + c * strideC] }
            }
        case .float16:
            let pointer = emission.dataPointer.assumingMemoryBound(to: Float16.self)
            for t in 0..<frames {
                for c in 0..<classes { values[t * classes + c] = Float(pointer[t * strideT + c * strideC]) }
            }
        default:
            throw AlignerError.badOutput("data type \(emission.dataType.rawValue)")
        }
        return (values, frames)
    }
}

// MARK: - Aligner

final class WordAligner: @unchecked Sendable {
    private let emitter: Wav2Vec2Emitter
    private let vocabulary: [Character: Int]

    init(directory: URL) throws {
        emitter = try Wav2Vec2Emitter(directory: directory)
        var vocab: [Character: Int] = [:]
        for (index, symbol) in emitter.labels.labels.enumerated() where symbol.count == 1 {
            vocab[Character(symbol)] = index
        }
        vocabulary = vocab
    }

    /// Output has the same order and count as `words`.
    func align(audioPath: String, words: [AlignWordInput]) throws -> [AlignedWordOutput] {
        guard !words.isEmpty else { return [] }
        let sampleRate = Double(emitter.labels.sampleRate)
        let pcm = try AudioConverter().resampleAudioFile(path: audioPath)

        var times: [Int: (start: Double, end: Double)] = [:]
        for window in alignmentWindows(words) {
            for (index, span) in try alignWindow(pcm: pcm, words: words, indices: window, sampleRate: sampleRate) {
                times[index] = span
            }
        }
        return words.enumerated().map { index, word in
            let aligned = times[index]
            let start = aligned?.start ?? word.startSec
            let end = aligned?.end ?? word.endSec
            return AlignedWordOutput(
                startSec: start,
                endSec: max(end, start + AlignerConstants.minimumWordSeconds),
                aligned: aligned != nil
            )
        }
    }

    private func alignWindow(
        pcm: [Float],
        words: [AlignWordInput],
        indices: [Int],
        sampleRate: Double
    ) throws -> [Int: (start: Double, end: Double)] {
        guard let firstIndex = indices.first, let lastIndex = indices.last else { return [:] }
        let t0 = max(0, words[firstIndex].startSec - AlignerConstants.margin)
        let t1 = min(Double(pcm.count) / sampleRate, words[lastIndex].endSec + AlignerConstants.margin)
        let from = min(max(0, Int(t0 * sampleRate)), pcm.count)
        let to = min(max(from, Int(t1 * sampleRate)), pcm.count)
        let chunkLength = to - from

        var tokens: [Int] = []
        var owner: [Int] = []  // word index per token, -1 for the separator
        var spelled = 0
        for index in indices {
            let letters = alignmentLetters(words[index].word).compactMap { vocabulary[$0] }
            guard !letters.isEmpty else { continue }
            if spelled > 0 {
                guard let separator = vocabulary[Character(emitter.labels.separator)] else { return [:] }
                tokens.append(separator)
                owner.append(-1)
            }
            for letter in letters {
                tokens.append(letter)
                owner.append(index)
            }
            spelled += 1
        }
        guard spelled > 0, Double(chunkLength) >= sampleRate * AlignerConstants.minChunkSeconds,
            chunkLength >= emitter.labels.minSamples, chunkLength <= emitter.labels.maxSamples
        else { return [:] }

        let (emission, frames) = try emitter.emissions(for: pcm[from..<to])
        let classes = emitter.labels.labels.count
        guard
            let path = emission.withUnsafeBufferPointer({
                ctcForcedAlign(
                    logProbs: $0, frames: frames, classes: classes, targets: tokens, blank: emitter.labels.blank)
            })
        else { return [:] }
        let spans = mergeTokens(path, blank: emitter.labels.blank)

        let step = (Double(chunkLength) / sampleRate) / Double(frames)
        var times: [Int: (start: Double, end: Double)] = [:]
        // `merge_tokens` yields one span per non-blank token run, in path order, which is the
        // target order, so spans and `owner` zip one to one.
        for (span, who) in zip(spans, owner) where who >= 0 {
            let start = t0 + Double(span.start) * step
            let end = t0 + Double(span.end) * step
            if let existing = times[who] {
                times[who] = (min(existing.start, start), max(existing.end, end))
            } else {
                times[who] = (start, end)
            }
        }
        return times
    }
}
