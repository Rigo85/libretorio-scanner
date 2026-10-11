import { randomUUID } from "crypto";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { ConversionCandidate, ConversionState, ConversionSummary, documentExtensions } from "(src)/models/interfaces/DocumentConversion";

const eligible = "(a.\"fileKind\"='FILE' AND lower(substring(a.name from '\\.[^.]+$'))=ANY($2::text[]))";
const suffixes = documentExtensions.map(extension => `.${extension}`);

export class DocumentConversionRepository {
	// Do not use the adapter's query wrapper: SQL errors must not look like an empty page.
	private query(text: string, values: unknown[]) {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const query = {text, values, query_timeout: 15000};
		return PostgresAdapter.getInstance().pool.query(query);
	}

	async window(root: number): Promise<{upper: number; total: number}> {
		const {rows} = await this.query(`SELECT coalesce(max(a.id),0)::int AS upper,count(*)::int AS total
            FROM archive a WHERE a.scan_root_id=$1 AND ${eligible}`, [root, suffixes]);
		return rows[0];
	}

	async page(root: number, after: number, upper: number, limit: number): Promise<ConversionCandidate[]> {
		const {rows} = await this.query(`SELECT a.id,a.name,a."parentPath",a."coverId",a."fileKind",
            CASE WHEN c.archive_id IS NOT NULL THEN c.details || jsonb_build_object(
                'status',c.status,'attempts',c.attempts,'retryAfter',c.retry_after) END AS conversion
            FROM archive a LEFT JOIN document_conversions c ON c.archive_id=a.id
            WHERE a.scan_root_id=$1 AND ${eligible} AND a.id>$3 AND a.id<=$4
            ORDER BY a.id LIMIT $5`, [root, suffixes, after, upper, limit]);
		return rows;
	}

	async start(root: number, upper: number, total: number): Promise<string> {
		// Caller holds the scan lease. Old runs are history, not an independent queue.
		await this.query(`UPDATE document_conversions c SET status='failed',attempts=least(c.attempts,2),retry_after=now(),
            details=c.details || '{"errorCode":"interrupted","error":"Previous scan ended before recording an outcome"}'::jsonb,updated_at=now()
            FROM archive a WHERE a.id=c.archive_id AND a.scan_root_id=$1 AND c.status='processing' AND ${eligible}`, [root, suffixes]);
		await this.query(`UPDATE document_conversion_runs SET status='interrupted',finished_at=now()
            WHERE scan_root_id=$1 AND status='running'`, [root]);
		const id = randomUUID();
		await this.query(`INSERT INTO document_conversion_runs(id,scan_root_id,upper_id,total,status)
            VALUES($1,$2,$3,$4,'running')`, [id, root, upper, total]);
		return id;
	}

	async save(id: number, run: string, state: ConversionState): Promise<void> {
		const {status, attempts, retryAfter, ...details} = state;
		await this.query(`INSERT INTO document_conversions(archive_id,run_id,status,attempts,retry_after,details)
            VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(archive_id) DO UPDATE SET
            run_id=EXCLUDED.run_id,status=EXCLUDED.status,attempts=EXCLUDED.attempts,
            retry_after=EXCLUDED.retry_after,details=EXCLUDED.details,updated_at=now()`,
		[id, run, status, attempts, retryAfter, JSON.stringify(details)]);
	}

	async progress(run: string, summary: ConversionSummary, status = "running", error?: string): Promise<void> {
		await this.query(`UPDATE document_conversion_runs SET summary=$2::jsonb,status=$3,last_error=$4,
            finished_at=CASE WHEN $3='running' THEN NULL ELSE now() END WHERE id=$1`,
		[run, JSON.stringify(summary), status, error?.slice(0, 4000)]);
	}
}
