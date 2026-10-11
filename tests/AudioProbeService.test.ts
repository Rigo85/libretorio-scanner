import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "@jest/globals";
import { normalizeAudioProbe, audioSourceSignature } from "(src)/services/AudioProbeService";

const probe = (chapters: any[] = []) => ({format: {duration: "100", format_name: "mov,mp4,m4a"},
	streams: [{codec_type: "audio", codec_name: "aac"}], chapters});
const chapter = (start: any, end: any, title = "Uno") => ({start_time: start, end_time: end, tags: {title}});

describe("audio probe normalization", () => {
	it("accepts Matroska/Opus with attachments without treating attachments as tracks", () => {
		const result = normalizeAudioProbe({...probe(), format: {duration: "100", format_name: "matroska,webm"},
			streams: [{codec_type: "audio", codec_name: "opus"}, {codec_type: "attachment"}]});
		expect(result.details).toMatchObject({format: "matroska,webm", codec: "opus", chapterCount: 0});
	});
	it("allows embedded covers but rejects real video, including video-only media", () => {
		const audio = {codec_type: "audio", codec_name: "mp3"};
		const cover = {codec_type: "video", codec_name: "mjpeg", disposition: {attached_pic: 1}};
		expect(normalizeAudioProbe({...probe(), streams: [audio, cover]}).status).toBe("ready");
		expect(normalizeAudioProbe({...probe(), streams: [audio, {codec_type: "video"}]})).toMatchObject({status: "skipped", details: {reason: "video"}});
		expect(normalizeAudioProbe({...probe(), streams: [cover]})).toMatchObject({status: "skipped", details: {reason: "no-audio-stream"}});
	});
	it("retains precise container times without guessing sample rate", () => {
		const result = normalizeAudioProbe(probe([chapter("0", "18.320"), chapter("18.320", "100")]));
		expect(result.status).toBe("ready");
		expect(result.chapters[1].startTimeInSeconds).toBe(18.32);
	});
	it("preserves successful absence of detected chapters", () => {
		expect(normalizeAudioProbe(probe())).toMatchObject({status: "ready", chapters: [], duration: 100});
	});
	it.each([
		[chapter("-1", "10")], [chapter("0", "0")], [chapter("10", "1")],
		[chapter("100", "150")], [chapter("NaN", "20")],
		[chapter("0", "20"), chapter("19", "30")],
		[chapter("0", "20"), chapter("0", "30")]
	])("flags invalid intervals and never publishes a partial list: %j", (...chapters) => {
		expect(normalizeAudioProbe(probe(chapters))).toMatchObject({status: "needs_review", chapters: []});
	});
	it("keeps Delirio's last chapter and reports its original end beyond duration", () => {
		const input = {...probe([chapter("0", "41694.856485"), chapter("41694.856485", "41729.608704", "Delirio")]),
			format: {duration: "41729.555737"}};
		const result = normalizeAudioProbe(input);
		expect(result.status).toBe("needs_review");
		expect(result.chapters).toHaveLength(2);
		expect(result.chapters[1]).toEqual({title: "Delirio", startTimeInSeconds: 41694.856485, endTimeInSeconds: 41729.555737});
		expect(result.details.warnings).toEqual([expect.stringContaining("originalEnd=41729.608704, normalizedEnd=41729.555737")]);
		expect(input.chapters[1].end_time).toBe("41729.608704");
	});
	it.each(["100.02", "150"])("accepts a finite final overflow %s without silently ignoring it", end => {
		const result = normalizeAudioProbe(probe([chapter("90", end)]));
		expect(result).toMatchObject({status: "needs_review", chapters: [{startTimeInSeconds: 90, endTimeInSeconds: 100}]});
		expect(result.details.warnings).toHaveLength(1);
	});
	it.each([
		[chapter("0", "101"), chapter("99", "100")],
		[chapter("0", "20"), chapter("19", "150")],
		[chapter("0", "Infinity")], [chapter("101", "150")], [chapter("100", "100.02")]
	])("does not relax other invalid intervals when preserving the final chapter: %j", (...chapters) => {
		expect(normalizeAudioProbe(probe(chapters))).toMatchObject({status: "needs_review", chapters: []});
	});
	it("allows gaps without fabricating chapters", () => {
		expect(normalizeAudioProbe(probe([chapter("10", "20"), chapter("30", "40")])).status).toBe("ready");
	});
	it("retains warning evidence", () => {
		expect(normalizeAudioProbe(probe(), "truncated data").status).toBe("needs_review");
	});
	it("flags missing titles", () => {
		expect(normalizeAudioProbe(probe([chapter("0", "10", "")])).status).toBe("needs_review");
	});
	it("rejects missing streams and invalid duration", () => {
		expect(() => normalizeAudioProbe({})).toThrow();
		expect(normalizeAudioProbe({...probe(), streams: []})).toMatchObject({status: "skipped"});
		expect(() => normalizeAudioProbe({...probe(), format: {duration: "Infinity"}})).toThrow();
	});
	it("invalidates replacements and rejects an escaping symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "audio-signature-"));
		try {
			const file = path.join(root, "test.m4b");
			await fs.writeFile(file, "old");
			const before = await audioSourceSignature(file, root);
			await fs.writeFile(file, "replaced");
			expect(await audioSourceSignature(file, root)).not.toBe(before);
			await fs.symlink("/etc/hosts", path.join(root, "escape.m4a"));
			await expect(audioSourceSignature(path.join(root, "escape.m4a"), root)).rejects.toThrow("outside");
		} finally {await fs.rm(root, {recursive: true, force: true});}
	});
});
