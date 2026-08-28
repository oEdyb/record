import FluidAudio
import Foundation
import NaturalLanguage

private struct TranscribeRequest: Decodable {
    let id: String
    let audioPath: String
    let language: String?
}

private struct TimedPhrase: Encodable {
    let text: String
    let startSec: Double
    let endSec: Double
}

private struct TimedWord: Encodable {
    let word: String
    let startSec: Double
    let endSec: Double
    let confidence: Float
}

private struct ReadyMessage: Encodable {
    let type = "ready"
    let backend = "parakeet-coreml"
    let model = "parakeet-tdt-0.6b-v3"
    let timestampFrameSec = ASRConstants.secondsPerEncoderFrame
}

private struct ResultMessage: Encodable {
    let type = "result"
    let id: String
    let segments: [TimedPhrase]
    let wordSegments: [TimedWord]
    let detectedLanguage: String
    let backend = "parakeet-coreml"
}

private struct ErrorMessage: Encodable {
    let type = "error"
    let id: String?
    let error: String
}

private enum HelperError: LocalizedError {
    case missingModelsArgument
    case invalidRequest

    var errorDescription: String? {
        switch self {
        case .missingModelsArgument:
            return "Usage: klippt-parakeet-stt --models <parakeet-v3-directory>"
        case .invalidRequest:
            return "The request is not valid JSON."
        }
    }
}

private struct WordAccumulator {
    private(set) var words: [TimedWord] = []
    private var text = ""
    private var startSec = 0.0
    private var endSec = 0.0
    private var confidenceTotal: Float = 0
    private var confidenceCount = 0

    mutating func append(_ timing: TokenTiming) {
        let token = timing.token
        guard !token.isEmpty, token != "<blank>", token != "<pad>" else { return }

        let startsWord = isWordBoundary(token) || text.isEmpty
        if startsWord, !text.isEmpty {
            flush()
        }
        if startsWord {
            text = stripWordBoundaryPrefix(token)
            startSec = timing.startTime
        } else {
            text += token
        }
        endSec = timing.endTime
        confidenceTotal += timing.confidence
        confidenceCount += 1
    }

    mutating func finish() -> [TimedWord] {
        flush()
        return words
    }

    private mutating func flush() {
        let word = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !word.isEmpty {
            words.append(
                TimedWord(
                    word: word,
                    startSec: max(0, startSec),
                    endSec: max(endSec, startSec + 0.001),
                    confidence: confidenceCount > 0
                        ? confidenceTotal / Float(confidenceCount)
                        : 0
                )
            )
        }
        text = ""
        startSec = 0
        endSec = 0
        confidenceTotal = 0
        confidenceCount = 0
    }
}

private func modelDirectory(from arguments: [String]) throws -> URL {
    guard let index = arguments.firstIndex(of: "--models"), arguments.indices.contains(index + 1)
    else {
        throw HelperError.missingModelsArgument
    }
    return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    var data = try JSONEncoder().encode(value)
    data.append(0x0A)
    try FileHandle.standardOutput.write(contentsOf: data)
}

private func log(_ message: String) {
    guard let data = "[klippt-parakeet-stt] \(message)\n".data(using: .utf8) else { return }
    try? FileHandle.standardError.write(contentsOf: data)
}

private func transcribe(
    request: TranscribeRequest,
    manager: AsrManager
) async throws -> ResultMessage {
    let audioURL = URL(fileURLWithPath: request.audioPath)
    let decoderLayers = await manager.decoderLayerCount
    var decoderState = TdtDecoderState.make(decoderLayers: decoderLayers)
    let language = request.language.flatMap(Language.init(rawValue:))
    let result = try await manager.transcribe(
        audioURL,
        decoderState: &decoderState,
        language: language
    )

    var accumulator = WordAccumulator()
    for timing in result.tokenTimings ?? [] {
        accumulator.append(timing)
    }
    let words = accumulator.finish()
    let phraseStart = words.first?.startSec ?? 0
    let phraseEnd = words.last?.endSec ?? max(0, result.duration)
    let phrases = result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? []
        : [
            TimedPhrase(
                text: result.text,
                startSec: phraseStart,
                endSec: max(phraseEnd, phraseStart + 0.001)
            )
        ]

	let detectedLanguage: String
	if let language {
		detectedLanguage = language.rawValue
	} else if
		let dominantLanguage = NLLanguageRecognizer.dominantLanguage(for: result.text),
		let supportedLanguage = Language(rawValue: dominantLanguage.rawValue)
	{
		detectedLanguage = supportedLanguage.rawValue
	} else {
		detectedLanguage = "auto"
	}

    return ResultMessage(
        id: request.id,
        segments: phrases,
        wordSegments: words,
        detectedLanguage: detectedLanguage
    )
}

@main
private enum KlipptParakeetSTT {
    static func main() async {
        do {
            let modelsURL = try modelDirectory(from: CommandLine.arguments)
            let config = ASRConfig(
                melChunkContext: false,
                dualDecodeArbitration: false,
                seamGapRepair: true
            )
            let manager = AsrManager(config: config)
            let models = try await AsrModels.load(
                from: modelsURL,
                version: .v3,
                encoderPrecision: .int8
            )
            try await manager.loadModels(models)
            try writeJSON(ReadyMessage())
            log("ready")

            while let line = readLine() {
                guard let data = line.data(using: .utf8) else { continue }
                let request: TranscribeRequest
                do {
                    request = try JSONDecoder().decode(TranscribeRequest.self, from: data)
                } catch {
                    try writeJSON(ErrorMessage(id: nil, error: HelperError.invalidRequest.localizedDescription))
                    continue
                }

                do {
                    try writeJSON(try await transcribe(request: request, manager: manager))
                } catch {
                    try writeJSON(
                        ErrorMessage(
                            id: request.id,
                            error: error.localizedDescription
                        )
                    )
                }
            }
        } catch {
            log(error.localizedDescription)
            try? writeJSON(ErrorMessage(id: nil, error: error.localizedDescription))
            Foundation.exit(EXIT_FAILURE)
        }
    }
}
