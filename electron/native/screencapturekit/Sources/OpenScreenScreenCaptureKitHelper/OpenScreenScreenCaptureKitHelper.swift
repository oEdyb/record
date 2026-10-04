import Foundation

@main
struct OpenScreenScreenCaptureKitHelper {
	static func main() async {
		do {
			guard CommandLine.arguments.count == 2 else {
				throw HelperError.invalidArguments
			}

			guard #available(macOS 13.0, *) else {
				throw HelperError.unsupportedMacOS
			}

			let requestData: Data
			if CommandLine.arguments[1] == HelperWarmup.standbyArgument {
				await HelperWarmup.run()
				emit(["event": "standby"])
				guard let line = HelperWarmup.awaitRequest() else { exit(0) }
				requestData = line
			} else {
				requestData = Data(CommandLine.arguments[1].utf8)
			}
			let decoder = JSONDecoder()
			let request = try decoder.decode(RecordingRequest.self, from: requestData)
			let commandExecutor = RecorderCommandExecutor()
			let recorder = ScreenCaptureRecorder(request: request) { recorder, error in
				_ = commandExecutor.submit {
					emitError(code: "capture-stopped-with-error", message: "\(error)")
					await recorder.stop()
				}
			}
			try await recorder.start()
			let stopTask = Task.detached {
				while let line = readLine() {
					let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
					if command.first == "{",
						let data = command.data(using: .utf8),
						let envelope = try? decoder.decode(RecorderCommand.self, from: data)
					{
						switch envelope.command {
						case "reconfigure":
							if let nextRequest = envelope.request {
								await commandExecutor.submit {
									await recorder.reconfigure(with: nextRequest)
								}.value
							} else {
								emitError(
									code: "invalid-reconfigure-request",
									message: "Reconfigure requires a complete recording request."
								)
							}
						default:
							break
						}
						continue
					}
					switch command {
					case "pause":
						await commandExecutor.submit {
							await recorder.pause()
						}.value
					case "resume":
						await commandExecutor.submit {
							await recorder.resume()
						}.value
					case "stop":
						await commandExecutor.submit {
							await recorder.stop()
						}.value
						exit(0)
					default:
						break
					}
				}
			}

			await stopTask.value
		} catch let error as HelperError {
			emitError(code: "helper-error", message: error.description)
			exit(1)
		} catch {
			emitError(code: "helper-error", message: "\(error)")
			exit(1)
		}
	}
}
