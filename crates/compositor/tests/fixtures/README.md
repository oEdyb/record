`seek-eof-vfr.mp4` is a synthetic 64×64 H.264 file generated for the EOF seek regression test. It has 50 frames over two seconds. Frames 20–29 are omitted while source timestamps remain unchanged. The final PTS is 59/30 seconds; seeking to 1.99 seconds must retain that frame.

Generated with the project's FFmpeg on macOS:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=64x64:duration=2:rate=30' \
  -vf "select='not(between(n,20,29))'" -fps_mode vfr \
  -c:v h264_videotoolbox -b:v 50k -movflags +faststart seek-eof-vfr.mp4
```

The fixture contains no external source media or audio.

`seek-eof-fragmented.mp4` is a synthetic 64×64 H.264 fragmented MP4 with 41
frames at 60 fps. Its final GOP contains 11 packets, fewer than the regression
test's 16 decode threads. Seeking into that GOP must drain the decoder at demux
EOF before returning the requested frame. The test also checks the final display
interval, sequential playback after seeking, and backward seeking after EOF.

Generated with the project's pinned LGPL FFmpeg on Linux:

```sh
ffmpeg -f lavfi -i testsrc2=size=64x64:rate=60 -frames:v 41 \
  -c:v libopenh264 -g 30 -b:v 100k \
  -movflags +frag_keyframe+empty_moov+default_base_moof seek-eof-fragmented.mp4
```
