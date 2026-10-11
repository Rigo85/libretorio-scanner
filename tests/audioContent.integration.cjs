// Run with Node 24 and the compiled AudioProbeService path as the first argument.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {AudioProbeService} = require(path.resolve(process.argv[2]));

async function main() {
  const root = await fs.mkdtemp(path.resolve(process.env.TMPDIR || '/tmp', 'audio-content-'));
  const probe = new AudioProbeService();
  let passed = 0;
  const generate = (file, format, codec, extra = []) => execFileSync('/usr/bin/ffmpeg', [
    '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', codec, ...extra, '-f', format, file
  ], {timeout: 30000});
  try {
    for (const [format, codec, filename, container] of [
      ['matroska', 'libopus', 'matroska-named.mp3', 'matroska'],
      ['webm', 'libopus', 'webm-no-extension', 'matroska'],
      ['mp3', 'libmp3lame', 'mp3-named.pdf', 'mp3'],
      ['ipod', 'aac', 'audiobook.m4a', 'mov'],
      ['ipod', 'aac', 'audiobook.m4b', 'mov'],
      ['mp4', 'aac', 'mp4-no-extension', 'mov'],
      ['ogg', 'libopus', 'opus-named.txt', 'ogg'],
      ['ogg', 'libvorbis', 'ogg-named.bin', 'ogg'],
      ['flac', 'flac', 'flac-named.mp3', 'flac'],
      ['wav', 'pcm_s16le', 'wav-no-extension', 'wav'],
    ]) {
      const file = path.join(root, filename);
      generate(file, format, codec);
      const detected = await probe.detectContainer(file);
      assert.ok(detected === container || (container === 'mp3' && detected === 'id3'), filename);
      const result = await probe.probe(file);
      assert.ok(result.duration > 0 && result.duration < 2, filename);
      assert.equal(result.chapters.length, 0);
      passed++;
    }
    for (const [name, contents] of [
      ['fake.mp3', 'This is plain text.'],
      ['pdf.m4b', '%PDF-1.4\nnot audio'],
      ['playlist.mp3', '#EXTM3U\n/etc/passwd\n'],
      ['empty.m4a', '']
    ]) {
      const file = path.join(root, name);
      await fs.writeFile(file, contents);
      assert.equal(await probe.detectContainer(file), undefined, name);
      await assert.rejects(probe.probe(file), /Unsupported audio container/);
      passed++;
    }
    const video = path.join(root, 'video-named.mp3');
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
      'color=black:s=16x16:d=1', '-c:v', 'libx264', '-f', 'matroska', video], {timeout: 30000});
    assert.equal((await probe.probe(video)).status, 'skipped');
    passed++;
    const av = path.join(root, 'video-and-audio.m4b');
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
      'color=black:s=16x16:d=1', '-f', 'lavfi', '-i', 'sine=duration=1',
      '-c:v', 'libx264', '-c:a', 'libopus', '-f', 'matroska', av], {timeout: 30000});
    assert.equal((await probe.probe(av)).status, 'skipped');
    passed++;
    const cover = path.join(root, 'cover.jpg');
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
      'color=black:s=16x16', '-frames:v', '1', cover], {timeout: 30000});
    const covered = path.join(root, 'covered.mp3');
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-nostdin', '-i', path.join(root, 'mp3-named.pdf'),
      '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', covered], {timeout: 30000});
    assert.ok((await probe.probe(covered)).duration > 0);
    passed++;
    const attached = path.join(root, 'attached.mp3');
    const subtitle = path.join(root, 'subtitle.srt');
    await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,500\nTest\n');
    generate(attached, 'matroska', 'libopus', ['-attach', subtitle, '-metadata:s:t', 'mimetype=application/x-subrip']);
    assert.equal((await probe.probe(attached)).details.codec, 'opus');
    passed++;
    console.log(`PASS ${passed} real content-detection/ffprobe cases; Node ${process.version}`);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
