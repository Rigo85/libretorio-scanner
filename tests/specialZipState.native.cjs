// Run after tsc: node tests/specialZipState.native.cjs [temporary-directory-root]
// Outside Jest's VM, with the actual ZIP writer, dates and filesystem operations.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("fs-extra");
const unzipper = require("unzipper");
require("./setup.cjs");
require("module-alias").addAlias("(src)", path.join(__dirname, "../dist"));
const {config} = require("../dist/config/configuration");
const {FileKind} = require("../dist/models/interfaces/File");
const {SpecialDirectoryArtifactService} = require("../dist/services/SpecialDirectoryArtifactService");
const {generateDirectoryZipArtifact, getZipPath} = require("../dist/utils/comicCacheUtils");
const {specialZipSignature, specialZipStatePath} = require("../dist/utils/specialZipState");

(async () => {
  const root = await fs.mkdtemp(path.join(process.argv[2] || os.tmpdir(), "special-zip-native-"));
  const log = console.log;
  console.log = (...args) => {
    if (!String(args[0]).includes("artifact-zip-progress")) log(...args);
  };
  try {
    config.production.paths.cache = path.join(root, "cache");
    const source = path.join(root, "source");
    const track = path.join(source, "track.mp3");
    const originalDate = new Date("2025-01-01T12:15:17.500Z");
    await fs.ensureDir(source);
    await fs.writeFile(track, "original track");
    await fs.utimes(track, originalDate, originalDate);
    const file = {name: "source", parentPath: root, parentHash: "p", fileHash: "f", coverId: "native-test", fileKind: FileKind.AUDIOBOOK, size: "0 B"};
    const run = () => SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);
    const zip = getZipPath(file.coverId);
    await generateDirectoryZipArtifact(source, file.coverId);
    const legacy = await specialZipSignature(zip);
    assert.equal((await run()).action, "adopted");
    assert.equal(await specialZipSignature(zip), legacy);
    assert.equal((await run()).action, "reused");
    await fs.writeFile(path.join(path.dirname(zip), "preserved.pdf"), "untouched");
    await fs.writeFile(track, "modified track");
    await fs.utimes(track, originalDate, originalDate);
    assert.equal((await run()).action, "rebuilt");
    assert.equal((await run()).action, "reused");
    const entries = await unzipper.Open.file(zip);
    assert.equal((await entries.files[0].buffer()).toString(), "modified track");
    assert.equal(await fs.readFile(path.join(path.dirname(zip), "preserved.pdf"), "utf8"), "untouched");
    assert.equal((await fs.readJson(specialZipStatePath(zip))).origin, "generated");

    // A directory with many small fixtures exercises inventory memory without real audio I/O.
    for (let index = 0; index < 1000; index++) {
      await fs.writeFile(path.join(source, `track-${index}.mp3`), String(index));
    }
    assert.equal((await run()).action, "rebuilt");
    assert.equal((await run()).action, "reused");
    assert.equal((await unzipper.Open.file(zip)).files.length, 1001);
    await fs.utimes(track, 1735689601.9999, 1735689601.9999);
    assert.equal((await run()).action, "rebuilt");
    assert.equal((await run()).action, "reused");
    console.log("NATIVE ZIP CHECK: PASS (legacy, reuse, same-size change, preservation, 1001 entries, date rounding)");
  } finally {
    console.log = log;
    await fs.remove(root);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
