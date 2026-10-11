const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const build = path.resolve(process.argv[2]);
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/no_database_used';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
require('module-alias').addAlias('(src)', build);
const {AudioContentDetector} = require(path.join(build, 'services/AudioContentDetector'));
const {AudioProbeService} = require(path.join(build, 'services/AudioProbeService'));
const {AudioMetadataService} = require(path.join(build, 'services/AudioMetadataService'));
const archiver = require('archiver');

async function zip(file, entries) {
  const archive = archiver('zip', {zlib: {level: 6}});
  const out = syncFs.createWriteStream(file);
  const done = new Promise((resolve, reject) => {out.on('close',resolve);out.on('error',reject);archive.on('error',reject);});
  archive.pipe(out);
  for (const [name,data,store] of entries) archive.append(data,{name,store});
  await archive.finalize(); await done;
}
async function main() {
  const root = await fs.mkdtemp(path.resolve(process.env.TMPDIR || '/tmp', 'audio-mixed-'));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    const audio = path.join(root,'real-audio.mp3');
    execFileSync('/usr/bin/ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','sine=duration=1','-c:a','libmp3lame','-f','mp3',audio]);
    const original = await fs.readFile(audio);
    const oldTagSize = original.subarray(6,10).reduce((size,byte) => size*128+byte,0);
    const tag = Buffer.alloc(10 + 2*1024*1024);
    tag.write('ID3'); tag[3]=4;
    let size=tag.length-10;
    for(let i=9;i>=6;i--){tag[i]=size&127;size>>=7;}
    const largeTag = path.join(root,'large-ID3.m4b');
    await fs.writeFile(largeTag,Buffer.concat([tag,original.subarray(10+oldTagSize)]));
    const probe = new AudioProbeService();
    assert.equal(await probe.detectContainer(largeTag),'id3');
    assert.ok((await probe.probe(largeTag)).duration>0);
    const padded = path.join(root,'padded-audio.pdf');
    await fs.writeFile(padded,Buffer.concat([Buffer.alloc(208),original.subarray(10+oldTagSize)]));
    assert.equal(await probe.detectContainer(padded),'auto');
    assert.ok((await probe.probe(padded)).duration>0);
    const partialFrame = path.join(root,'partial-frame.pdf');
    await fs.writeFile(partialFrame,Buffer.concat([Buffer.from('b84dd67c99b48c46b2a8e4f0320e8ffcaac5bf3d80a3cee51e7983477eb2d163','hex'),original.subarray(10+oldTagSize)]));
    assert.equal(await probe.detectContainer(partialFrame),'auto');
    assert.ok((await probe.probe(partialFrame)).duration>0);
    const executable = path.join(root,'executable.mp3');
    await fs.writeFile(executable,Buffer.concat([Buffer.from('MZ'),Buffer.alloc(126),original.subarray(10+oldTagSize)]));
    assert.equal(await probe.detectContainer(executable),undefined);
    const names = ['a newline\nfile.m4b','name with spaces.mp3','name-\u00f1.mp3'];
    for(const name of names) await fs.copyFile(audio,path.join(root,name));
    assert.deepEqual((await probe.detectContainers(names.map(name=>path.join(root,name)))).map(r=>r.container),['id3','id3','id3']);
    const document = path.join(root,'document.mp3');
    await zip(document,[['mimetype','application/epub+zip',true],['META-INF/container.xml','<container/>',false],['book.xhtml','<html><body>Test</body></html>',false]]);
    const compressed = path.join(root,'compressed.m4b');
    await zip(compressed,[['[Content_Types].xml',Buffer.alloc(16*1024*1024,65),false]]);
    const audioZip = path.join(root,'audio-inside-zip.mp3');
    await zip(audioZip,[['track',original.subarray(10+oldTagSize),true]]);
    assert.equal(await probe.detectContainer(audioZip),undefined);
    const truncated = path.join(root,'truncated.zip');
    await fs.writeFile(truncated,Buffer.from([0x50,0x4b,3,4]));
    const empty = path.join(root,'empty.m4b');
    await fs.writeFile(empty,'');
    for(const file of [document,compressed,empty]) assert.equal(await probe.detectContainer(file),undefined);
    await assert.rejects(probe.probe(truncated));

    const video = path.join(root,'video-disguised.m4b');
    execFileSync('/usr/bin/ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=black:s=16x16:d=1','-f','lavfi','-i','sine=duration=1',
      '-c:v','libx264','-c:a','aac','-f','mp4',video]);
    assert.equal((await probe.probe(video)).status,'skipped');

    const fixture = path.join(__dirname,'fixtures/audio-detector-fault.sh');
    await fs.chmod(fixture,0o755);
    const unreliable = new AudioContentDetector(fixture,200);
    for(const fault of ['detector-hang','detector-crash','detector-bad-response']) {
      const file=path.join(root,fault);await fs.copyFile(audio,file);
      const result=await unreliable.detect([audio,file,largeTag]);
      assert.equal(result[0].container,'id3',fault);
      assert.ok(result[1].error,fault);
      assert.equal(result[2].container,'id3',fault);
    }
    assert.ok((await probe.detectContainers([path.join(root,'missing-file')]))[0].error);
    const uppercase=path.join(root,'detector-uppercase');await fs.writeFile(uppercase,'text');
    assert.deepEqual(await unreliable.detect([uppercase]),[{container:undefined}]);
    const lowScoreFixture=path.join(__dirname,'fixtures/audio-probe-low-score.sh');
    await fs.chmod(lowScoreFixture,0o755);
    await assert.rejects(new AudioProbeService(lowScoreFixture).probe(audio,'auto'),/Insufficient confidence/);
    const openDescriptors=(await fs.readdir('/proc/self/fd')).filter(fd=>{
      try{return syncFs.readlinkSync(`/proc/self/fd/${fd}`)===audio;}catch{return false;}
    });
    assert.equal(openDescriptors.length,0,'Source descriptor leaked on failed validation');

    // Complete mixed traversal, not just isolated successful probes.
    const files=[];
    const add = name => files.push({id:files.length+1,name,parentPath:root,fileKind:'FILE'});
    for(const file of [audio,largeTag,video,document,compressed,truncated,empty]) add(path.basename(file));
    for(let i=0;i<3000;i++) {
      const name=`document-${i}.${i%2?'epub':'docx'}`;
      await fs.copyFile(i%2?document:compressed,path.join(root,name));add(name);
    }
    const rows=new Map(); let extractions=0; let claims=0;
    const key=(id,relative)=>JSON.stringify([id,relative]);
    const repository={
      list:async()=>[...rows.values()],
      claim:async(id,relative,signature,version)=>{claims++;rows.set(key(id,relative),{archiveId:id,relativePath:relative,sourceSignature:signature,extractorVersion:version,status:'processing'});return 'token';},
      complete:async(id,relative,token,result)=>{rows.get(key(id,relative)).status=result.status;return true;},
      fail:async()=>assert.fail('Unexpected failure in mixed corpus'),removeMissing:async()=>{}
    };
    const realProbe=probe.probe.bind(probe);
    probe.probe=async(...args)=>{extractions++;return realProbe(...args);};
    const started=Date.now();
    const first=await new AudioMetadataService(repository,probe).process(files,root);
    const firstMs=Date.now()-started;
    assert.equal(first.failed,0);assert.equal(first.checked,3007);assert.equal(first.extracted,2);assert.equal(first.skipped,3005);
    assert.equal(first.extensionSkipped,3001);assert.equal(first.headersInspected,6);
    assert.equal(rows.size,3);assert.equal(extractions,3);assert.equal(claims,3);
    const secondStarted=Date.now();
    const second=await new AudioMetadataService(repository,probe).process(files,root);
    const secondMs=Date.now()-secondStarted;
    assert.equal(second.failed,0);assert.equal(second.extracted,0);assert.equal(second.reusedOrDeferred,2);assert.equal(second.skippedReused,1);
    assert.equal(second.extensionSkipped,3001);assert.equal(second.headersInspected,3);
    assert.equal(extractions,3);assert.equal(claims,3);
    assert.ok(logs.some(line=>line.includes('audio-metadata:progress')&&line.includes('headersInspected')));
    assert.equal(logs.filter(line=>line.includes('audio-metadata:complete')).length,2);
    // The old AbortSignal failure could occur after a successful detector return.
    await new Promise(resolve=>setTimeout(resolve,11000));
    assert.equal(await probe.detectContainer(audio),'id3');
    console.log=originalLog;
    console.log(JSON.stringify({pass:true,largeId3Bytes:tag.length,mixedFiles:files.length,first,firstMs,second,secondMs,
      faultCases:3,lateCancellationWaitMs:11000},null,2));
  } finally {console.log=originalLog;await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
