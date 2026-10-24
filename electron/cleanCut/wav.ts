import { roundHalfEven } from "./pyCompat";

/** Mono 16-bit PCM WAV bytes. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
	const data = samples.length * 2;
	const buf = Buffer.alloc(44 + data);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + data, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(data, 40);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		buf.writeInt16LE(roundHalfEven(v * 32767), 44 + i * 2);
	}
	return buf;
}
