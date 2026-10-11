import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { DocumentConversionRepository } from "(src)/repositories/DocumentConversionRepository";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { documentExtensions } from "(src)/models/interfaces/DocumentConversion";

describe("PDF scan eligibility", () => {
	afterEach(() => jest.restoreAllMocks());
	it("excludes EPUB while retaining the other supported formats", () => {
		expect(documentExtensions).toEqual(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf", "txt", "md", "html", "htm", "lit"]);
	});
	it("uses the same non-EPUB FILE filter for counting, pagination and interrupted-item recovery", async () => {
		const query = jest.fn(async () => ({rows: [{upper: 7, total: 1}]}));
		jest.spyOn(PostgresAdapter, "getInstance").mockReturnValue({pool: {query}} as unknown as PostgresAdapter);
		const repository = new DocumentConversionRepository();
		await repository.window(5);
		await repository.page(5, 0, 7, 50);
		await repository.start(5, 7, 1);
		for (const call of query.mock.calls.slice(0, 3)) {
			const request = (call as unknown as [{text: string; values: unknown[]}])[0];
			expect(request.text).toContain('a."fileKind"=\'FILE\'');
			expect(request.text).not.toContain('a."fileKind"=\'EPUB\'');
			expect(request.values.slice(0, 2)).toEqual([5, documentExtensions.map(extension => `.${extension}`)]);
		}
	});
});
