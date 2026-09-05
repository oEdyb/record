`seek-eof-vfr.mp4` is a synthetic 64×64 H.264 file generated for the EOF seek regression test. It has 50 frames over two seconds. Frames 20–29 are omitted while source timestamps remain unchanged. The final PTS is 59/30 seconds; seeking to 1.99 seconds must retain that frame.

Generated with the project's FFmpeg on macOS:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=64x64:duration=2:rate=30' \
  -vf "select='not(between(n,20,29))'" -fps_mode vfr \
  -c:v h264_videotoolbox -b:v 50k -movflags +faststart seek-eof-vfr.mp4
```

The fixture contains no external source media or audio.
