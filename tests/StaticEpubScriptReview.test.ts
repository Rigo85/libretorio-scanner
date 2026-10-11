import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import { staticEpubScriptReview } from "(src)/services/StaticEpubScriptReview";

const fixture = String.raw`import sys,json,tempfile,zipfile,pathlib
body,pdf=json.loads(sys.argv[1])
with tempfile.TemporaryDirectory() as tmp:
 book=str(pathlib.Path(tmp)/'book.epub')
 text=str(pathlib.Path(tmp)/'text.txt')
 with zipfile.ZipFile(book,'w') as archive:
  archive.writestr('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
  archive.writestr('content.opf','<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="chapter.html" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>')
  archive.writestr('chapter.html','<html><head><script src="/js/jquery.js"></script><link rel="stylesheet" href="/css/template_css.css"></head><body>'+body+'</body></html>')
 pathlib.Path(text).write_text(pdf,encoding='utf-8')
 sys.argv=['review',book,text]
 exec(sys.argv_review)
`;

function review(body: string, pdf: string) {
	return spawnSync("python3", ["-c", "import sys\nsys.argv_review=" + JSON.stringify(staticEpubScriptReview) + "\n" + fixture, JSON.stringify([body, pdf])],
		{encoding: "utf8", timeout: 10000});
}

describe("static EPUB script review", () => {
	it("accepts verified static text, including soft hyphens and PDF line wrapping", () => {
		const result = review("<p>A complete narra\u00adtion.</p>", "A complete narra-\ntion.");
		expect(result.stderr).toBe(""); expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).verified).toBe(true);
	});
	it.each([
		["<p>A full chapter.</p>", "A chapter."],
		["<p></p>", ""],
		["<p>A chapter.</p><script>document.write('more')</script>", "A chapter."],
		["<p onclick=\"loadChapter()\">A chapter.</p>", "A chapter."],
		["<p>A chapter.</p><script src='/js/chapter.js'></script>", "A chapter."],
		["<p>A chapter.</p><img src='missing.jpg'>", "A chapter."],
		["<p>A chapter.</p><canvas></canvas>", "A chapter."],
		["<p>A chapter.</p><link rel='stylesheet' href='unknown.css'>", "A chapter."]
	])("rejects unverified or dynamic content: %s", (body, pdf) => {
		expect(review(body, pdf).status).not.toBe(0);
	});
});
