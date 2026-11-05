export function nativeErrorMessage(message: string): string {
	if (/(?:avcodec_)?(?:receive_frame|send_packet)[^\n]*-1094995529\b/.test(message)) {
		return "This video contains damaged or incomplete frames. Restore the original recording or choose another video.";
	}
	return message;
}
