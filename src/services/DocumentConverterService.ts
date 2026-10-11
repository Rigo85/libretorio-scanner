import fs from "fs-extra";
import path from "path";
import { DocumentSource, fileDigest } from "./DocumentSourceService";
import { ConversionProcessService } from "./ConversionProcessService";
import { ConversionError, conversionInfrastructureErrorCodes } from "(src)/models/interfaces/DocumentConversion";
import { staticEpubScriptReview } from "./StaticEpubScriptReview";

const optionalScriptWarning = /^Blocking FAKE_PROTOCOL request: clbr:\/\/internal\.invalid\/js\/(?:jquery|jquery-ui|ddslick)\.js with code: Error\.UrlNotFound$/;

export class DocumentConverterService {
	readonly recipe = "libretorio-pdf-v2";
	readonly processes = new ConversionProcessService();
	private versions = new Map<string, string>();
	static hasReviewableScriptWarning(message: string): boolean {
		return message.split(/\r?\n/).some(line => optionalScriptWarning.test(line.trim()));
	}
	constructor(private readonly calibre = path.join(__dirname, "calibre"),
		private readonly timeoutMs = Number(process.env.PDF_CONVERSION_TIMEOUT_MS || 15 * 60 * 1000)) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid PDF conversion timeout");
	}

	tool(source: DocumentSource): string {
		if (["doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf"].includes(source.extension)) return "libreoffice";
		if (["html", "htm"].includes(source.extension)) return "htmldoc";
		if (["epub", "txt", "md", "lit"].includes(source.extension)) return "calibre";
		throw new ConversionError("unsupported", "Unsupported document extension");
	}

	private async sandbox(work: string, input: string, binary: string, args: string[], timeout = this.timeoutMs) {
		this.processes.check();
		for (const required of ["/usr/bin/bwrap", "/usr/bin/prlimit", "/usr/bin/pdfinfo", "/usr/bin/file"]) {
			if (!await fs.pathExists(required)) throw new ConversionError("tool_missing", `Required tool absent: ${required}`, true);
		}
		const mounts: string[] = [];
		for (const directory of ["/usr", "/bin", "/lib", "/lib64", "/etc/fonts", "/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"]) {
			if (await fs.pathExists(directory)) mounts.push("--ro-bind", directory, directory);
		}
		if (binary === "/usr/bin/libreoffice") {
			for (const directory of ["/etc/libreoffice", "/var/lib/libreoffice", "/var/spool/libreoffice"]) {
				if (await fs.pathExists(directory)) mounts.push("--ro-bind", directory, directory);
			}
		}
		if (binary.startsWith("/opt/calibre/")) {
			if (!await fs.pathExists(path.join(this.calibre, "ebook-convert"))) throw new ConversionError("tool_missing", "Project Calibre is absent", true);
			mounts.push("--ro-bind", await fs.realpath(this.calibre), "/opt/calibre");
		} else if (!await fs.pathExists(binary)) throw new ConversionError("tool_missing", `Required tool absent: ${binary}`, true);
		await fs.ensureDir(path.join(work, "home"));
		const calibre = binary.startsWith("/opt/calibre/");
		const limits = [Number(calibre ? process.env.PDF_CONVERSION_CALIBRE_MEMORY_BYTES || 6442450944 : process.env.PDF_CONVERSION_MEMORY_BYTES || 2147483648),
			Number(process.env.PDF_CONVERSION_CPU_SECONDS || 900), Number(process.env.PDF_CONVERSION_MAX_BYTES || 4294967296),
			Number(process.env.PDF_CONVERSION_ADDRESS_SPACE_BYTES || 1099511627776)];
		if (limits.some(value => !Number.isSafeInteger(value) || value < 1)) throw new ConversionError("configuration", "Invalid PDF resource limits", true);
		const openFiles = binary.startsWith("/opt/calibre/") ? 2048 : 256;
		const result = await this.processes.run("/usr/bin/prlimit", [`--as=${limits[3]}`, `--cpu=${limits[1]}`, `--fsize=${limits[2]}`, `--nofile=${openFiles}`, "--",
			"/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", ...mounts,
			"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", input, "/input", "--bind", work, "/work",
			"--chdir", "/work", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/work/home",
			"--setenv", "LANG", "C.UTF-8", "--setenv", "LC_ALL", "C.UTF-8", "--setenv", "QT_QPA_PLATFORM", "offscreen",
			"--", binary, ...args], timeout, limits[0]).catch(async error => {
			await fs.writeJson(path.join(work, "process-error.json"), {binary, args, code: error.code, error: error.message, diagnostics: error.diagnostics});
			if (error.message.includes("bwrap:")) throw new ConversionError("sandbox", error.message, true);
			if (/No space left on device|Disk quota exceeded|Read-only file system|Input\/output error/i.test(error.message)) {
				if (/Read-only file system[^\n]*['"]\/input\//i.test(error.message) && !/No space left on device|Disk quota exceeded|Input\/output error/i.test(error.message)) {
					throw new ConversionError("source_readonly", error.message);
				}
				throw new ConversionError("storage", error.message, true);
			}
			if (/cannot open shared object file|error while loading shared libraries|Failed to import PyQt module/i.test(error.message)) {
				throw new ConversionError("tool_runtime", error.message, true);
			}
			throw error;
		});
		return result;
	}

	async version(source: DocumentSource, work: string): Promise<string> {
		const tool = this.tool(source);
		if (!this.versions.has(tool)) {
			const binary = tool === "calibre" ? "/opt/calibre/ebook-convert" : `/usr/bin/${tool}`;
			const result = await this.sandbox(work, work, binary, ["--version"], 30000);
			const version = (result.stdout || result.stderr).trim().slice(0, 500);
			if (!version) throw new ConversionError("tool_version", `No version reported by ${tool}`, true);
			this.versions.set(tool, version);
		}
		return this.versions.get(tool)!;
	}

	async convert(source: DocumentSource, work: string, onStart?: () => void): Promise<{output: string; warnings: string; recoveries?: string[];
		diagnostics: {stdout: string; stderr: string};}> {
		if (source.size === 0) throw new ConversionError("source_empty", "Source file is empty");
		let input = `/input/${source.inputName}`;
		if (source.directory) {
			if (!await fs.pathExists(path.join(work, "input.epub"))) throw new ConversionError("epub_zip", "Prepared EPUB input is missing");
			input = "/work/input.epub";
		} else {
			const mime = (await this.sandbox(work, source.inputRoot, "/usr/bin/file",
				["-b", "--mime-type", "-P", "bytes=16384", "--", input], 10000)).stdout.trim().toLowerCase();
			// Candidate extensions select work; known non-document content must not be sent to a converter.
			if (/^(audio|video|image)\//.test(mime) || ["application/pdf", "application/x-executable", "application/x-dosexec",
				"application/x-rar", "application/vnd.rar", "application/x-7z-compressed"].includes(mime)) {
				throw new ConversionError("unsupported_content", `Non-document source content: ${mime}`);
			}
		}
		const tool = this.tool(source);
		let result: {stdout: string; stderr: string};
		const recoveries: string[] = [];
		let output = path.join(work, "result.pdf");
		onStart?.();
		if (tool === "libreoffice") {
			result = await this.sandbox(work, source.inputRoot, "/usr/bin/libreoffice",
				["-env:UserInstallation=file:///work/profile", "--headless", "--convert-to", "pdf", "--outdir", "/work", input]);
			output = path.join(work, `${path.basename(source.inputName, path.extname(source.inputName))}.pdf`);
		} else if (tool === "htmldoc") {
			result = await this.sandbox(work, source.inputRoot, "/usr/bin/htmldoc", ["--webpage", "-f", "/work/result.pdf", input]);
		} else {
			const args = [input, "/work/result.pdf", ...(source.extension === "md" ? ["--formatting-type", "markdown"] : [])];
			try {
				result = await this.sandbox(work, source.inputRoot, "/opt/calibre/ebook-convert", args);
			} catch (error) {
				if (error.code !== "converter" || !/PoDoFo/.test(error.message) || !/UnsupportedImageFormat|Unknown magic/.test(error.message) || !["epub", "lit"].includes(source.extension)) throw error;
				await fs.writeFile(path.join(work, "cover-recovery-error.txt"), error.message);
				let epub = input;
				if (source.extension === "lit") {
					const intermediate = await this.sandbox(work, source.inputRoot, "/opt/calibre/ebook-convert", [input, "/work/cover-source.epub"]);
					this.checkResources(intermediate.stderr);
					epub = "/work/cover-source.epub";
				}
				const script = `import sys,zipfile,posixpath,json,hashlib
from xml.etree import ElementTree as ET
from PIL import Image
from io import BytesIO
Image.MAX_IMAGE_PIXELS=40000000
with zipfile.ZipFile(sys.argv[1]) as z:
 def read(name,limit):
  i=z.getinfo(name)
  if i.file_size>limit: raise ValueError('Cover resource too large')
  return z.read(i)
 root=ET.fromstring(read('META-INF/container.xml',1048576))
 opf=next(e for e in root.iter() if e.tag.endswith('}rootfile')).get('full-path')
 package=ET.fromstring(read(opf,4194304))
 cover=next(e.get('content') for e in package.iter() if e.tag.endswith('}meta') and e.get('name')=='cover')
 item=next(e for e in package.iter() if e.tag.endswith('}item') and e.get('id')==cover)
 from urllib.parse import unquote
 name=posixpath.normpath(posixpath.join(posixpath.dirname(opf),unquote(item.get('href'))))
 im=Image.open(BytesIO(read(name,33554432)))
 if getattr(im,'n_frames',1)!=1 or im.format in ('JPEG','PNG'): raise ValueError('No supported lossless cover recovery')
 before=im.convert('RGBA'); before.save(sys.argv[2],'PNG',icc_profile=im.info.get('icc_profile'))
 after=Image.open(sys.argv[2]).convert('RGBA')
 if before.size!=after.size or before.tobytes()!=after.tobytes(): raise ValueError('Cover pixels changed')
 print(json.dumps({'format':im.format,'size':im.size,'sha256':hashlib.sha256(before.tobytes()).hexdigest()}))`;
				const executableScript = "def recover():\n" + script.split("\n").map(line => " " + line).join("\n") + "\nrecover()";
				const cover = await this.sandbox(work, source.inputRoot, "/opt/calibre/calibre-debug", ["-c", executableScript, "--", epub, "/work/recovered-cover.png"]);
				await fs.writeFile(path.join(work, "cover-recovery.json"), cover.stdout);
				await fs.remove(output);
				result = await this.sandbox(work, source.inputRoot, "/opt/calibre/ebook-convert", [...args, "--cover", "/work/recovered-cover.png"]);
				recoveries.push("lossless-cover-png");
			}
		}
		await fs.writeJson(path.join(work, "converter-diagnostics.json"), {tool, stdout: result.stdout, stderr: result.stderr, recoveries});
		try {
			this.checkResources(result.stderr);
		} catch (error) {
			if (source.extension !== "epub" || !DocumentConverterService.hasReviewableScriptWarning(result.stderr)) throw error;
			const remaining = result.stderr.split(/\r?\n/).filter(line => !optionalScriptWarning.test(line.trim())).join("\n");
			this.checkResources(remaining);
			try {
				const text = await this.sandbox(work, source.inputRoot, "/usr/bin/pdftotext", ["-layout", "/work/result.pdf", "/work/script-review.txt"], 60000);
				if (text.stderr.trim()) throw new Error(text.stderr);
				const review = await this.sandbox(work, source.inputRoot, "/opt/calibre/calibre-debug",
					["-c", staticEpubScriptReview, "--", input, "/work/script-review.txt"], 60000);
				if (JSON.parse(review.stdout).verified !== true) throw new Error("Static EPUB verification did not succeed");
				await fs.writeJson(path.join(work, "script-review.json"), JSON.parse(review.stdout));
			} catch (failure) {
				if (conversionInfrastructureErrorCodes.has(failure.code)) throw failure;
				if (failure instanceof ConversionError && (failure.fatal || failure.code === "interrupted")) throw failure;
				throw new ConversionError("missing_resource", `Static script review failed: ${String(failure.message).slice(-2000)}`);
			}
			recoveries.push("verified-static-epub-scripts");
		}
		return {output, warnings: result.stderr.slice(-4000), recoveries, diagnostics: result};
	}

	private checkResources(stderr: string): void {
		if (/Too many open files|\bEMFILE\b/i.test(stderr)) {
			throw new ConversionError("fd_limit", `Converter exhausted file descriptors: ${stderr.slice(-6000)}`);
		}
		if (/Blocking FAKE_PROTOCOL request[^\n]*Error\.|Failed to load (?:image|resource)|Cannot (?:open|read|load) image/i.test(stderr)) {
			throw new ConversionError("missing_resource", `Converter omitted a resource: ${stderr.slice(-6000)}`);
		}
	}

	async validate(pdf: string, work: string): Promise<number> {
		const result = await this.sandbox(work, path.dirname(pdf), "/usr/bin/pdfinfo", [`/input/${path.basename(pdf)}`], 60000)
			.catch(error => {
				// A parser rejection is different from timeout, interruption or infrastructure failure.
				const stderr = error.diagnostics?.stderr || error.message;
				if (error.code === "converter" && !error.fatal && /Too many open files|\bEMFILE\b/.test(stderr)) {
					throw Object.assign(new ConversionError("fd_limit", error.message), {diagnostics: error.diagnostics});
				}
				if (error.code === "converter" && !error.fatal && /Syntax Error[^\n]*:/.test(stderr) &&
					!/Permission denied|I\/O Error|Input\/output error|Cannot allocate memory|Out of memory/i.test(stderr)) {
					throw Object.assign(new ConversionError("invalid_pdf", error.message), {diagnostics: error.diagnostics});
				}
				throw error;
			});
		const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(result.stdout)?.[1]);
		const encrypted = /^Encrypted:\s+yes/m.test(result.stdout);
		if (Number.isInteger(pages) && pages > 0 && !encrypted && path.dirname(pdf) === work && /Syntax Error(?: \(\d+\))?: (Unterminated string|End of file inside dictionary)/.test(result.stderr)) {
			const repaired = path.join(work, "normalized.pdf");
			const sandboxPdf = `/work/${path.basename(pdf)}`;
			await this.sandbox(work, work, "/usr/bin/qpdf", [sandboxPdf, "/work/normalized.pdf"]);
			await this.sandbox(work, work, "/usr/bin/qpdf", ["--check", "/work/normalized.pdf"]);
			const checked = await this.sandbox(work, work, "/usr/bin/pdfinfo", ["/work/normalized.pdf"], 60000);
			if (checked.stderr.trim() || /^Encrypted:\s+yes/m.test(checked.stdout) || Number(/^Pages:\s+(\d+)\s*$/m.exec(checked.stdout)?.[1]) !== pages) throw new ConversionError("invalid_pdf", "Normalized PDF changed page count or still has errors");
			for (const [file, name] of [[sandboxPdf, "before"], ["/work/normalized.pdf", "after"]]) await this.sandbox(work, work, "/usr/bin/pdftotext", [file, `/work/${name}.txt`], 60000);
			if (await fileDigest(path.join(work, "before.txt")) !== await fileDigest(path.join(work, "after.txt"))) throw new ConversionError("invalid_pdf", "Normalized PDF changed extracted text");
			await fs.writeJson(path.join(work, "pdf-normalization.json"), {originalError: result.stderr, pages});
			await fs.rename(repaired, pdf);
			return pages;
		}
		if (!Number.isInteger(pages) || pages < 1 || encrypted || result.stderr.trim()) {
			throw new ConversionError("invalid_pdf", `PDF validation failed: ${result.stderr.slice(-1000)}`);
		}
		return pages;
	}
}
