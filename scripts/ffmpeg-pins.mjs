/**
 * Immutable FFmpeg inputs used by every Klippt release build.
 *
 * Build scripts and the release inventory import this module. Keep the tag,
 * asset names, source version, configure flags, and SHA-256 values together.
 */

export const FFMPEG_RELEASE_TAG = "autobuild-2026-07-31-14-10";

export const FFMPEG_ARCHIVES = Object.freeze({
	"win32-x64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip",
		sha256: "089e4169e93b2b3f3acbfced3c0704d24276a225641bdda04d796d28b07a2a38",
		exe: "ffmpeg.exe",
	}),
	"win32-arm64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-lgpl-8.1.zip",
		sha256: "5b55ac00360811ef08513c76240c93e52a369cd29040d21799e7758fc7e9eaea",
		exe: "ffmpeg.exe",
	}),
	"linux-x64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1.tar.xz",
		sha256: "8c8b2897f2a8093ae2d985f7f1867d218451d4c567c1b2437f86a7c73a950b9f",
		exe: "ffmpeg",
		probe: Object.freeze({
			name: "ffprobe",
			size: 114982280,
			sha256: "f76afe5f9ad41be0b17b88504a91e7af891edde432c9a66f2444c7e121ba98fa",
		}),
	}),
	"linux-arm64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-lgpl-8.1.tar.xz",
		sha256: "0c8716a94ac1fe22eb56e7a0cedd0f00c1d8fae712ec19973d679a7a87916743",
		exe: "ffmpeg",
		probe: Object.freeze({
			name: "ffprobe",
			size: 93315328,
			sha256: "0efca65af6fd16500f9c1c641f55ff480c798c5b5b2d966e8e16dc3714d619b9",
		}),
	}),
});

export const FFMPEG_SHARED_ARCHIVES = Object.freeze({
	"linux-x64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-shared-8.1.tar.xz",
		sha256: "c882a80f06617149198a98a07a0880a7e881953ae9f9cb931f5be09a4f93caae",
	}),
	"linux-arm64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-lgpl-shared-8.1.tar.xz",
		sha256: "eec386482ac6799bb547b5f507dedd19ef6354eee0ca4ddb04bdd053d03c3cfb",
	}),
	"win32-x64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip",
		sha256: "c222a490dde4e7059f45495deef6bfb98dbcacc2b43df5b607546252037aa95c",
	}),
	"win32-arm64": Object.freeze({
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-lgpl-shared-8.1.zip",
		sha256: "4abab52904037ecad91b54811d69005a0b2e1f591242fd1517d32b299246ece0",
	}),
});

export const FFMPEG_MAC_SOURCE = Object.freeze({
	version: "8.1.2",
	sha256: "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
	urls: Object.freeze([
		"https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
		"https://deb.debian.org/debian/pool/main/f/ffmpeg/ffmpeg_8.1.2.orig.tar.xz",
	]),
	configureFlags: Object.freeze([
		"--enable-shared",
		"--disable-static",
		"--disable-doc",
		"--disable-debug",
		"--disable-xlib",
		"--disable-libxcb",
		"--disable-sdl2",
		"--disable-lzma",
		"--enable-videotoolbox",
		"--enable-audiotoolbox",
		"--disable-x86asm",
	]),
});
