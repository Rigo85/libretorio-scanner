import { randomUUID } from "crypto";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { AudioProbeResult } from "(src)/services/AudioProbeService";

export class AudioMetadataRepository {
	async list() {
		const {rows} = await PostgresAdapter.getInstance().pool.query<{
			archiveId: number; relativePath: string; sourceSignature: string; extractorVersion: string; status: string;
		}>(`SELECT archive_id AS "archiveId",relative_path AS "relativePath",source_signature AS "sourceSignature",
			extractor_version AS "extractorVersion",status FROM audio_metadata`);
		return rows;
	}

	async claim(id: number, relative: string, signature: string, version: string): Promise<string | undefined> {
		const token = randomUUID();
		// A crash on the final attempt must not leave a permanent processing state.
		await PostgresAdapter.getInstance().pool.query(`
            UPDATE audio_metadata SET status='failed',job_token=NULL,lease_until=NULL,
                last_error='Extraction lease expired after final attempt',updated_at=now()
            WHERE archive_id=$1 AND relative_path=$2 AND status='processing'
                AND attempts>=3 AND lease_until<now()`, [id, relative]);
		const {rows} = await PostgresAdapter.getInstance().pool.query(`
            INSERT INTO audio_metadata AS old
                (archive_id,relative_path,source_signature,extractor_version,status,attempts,job_token,lease_until)
            VALUES ($1,$2,$3,$4,'processing',1,$5,now()+interval '5 minutes')
            ON CONFLICT (archive_id,relative_path) DO UPDATE SET
                source_signature=EXCLUDED.source_signature,extractor_version=EXCLUDED.extractor_version,
                status='processing',job_token=EXCLUDED.job_token,lease_until=EXCLUDED.lease_until,
                attempts=CASE WHEN old.source_signature=$3 AND old.extractor_version=$4 THEN old.attempts+1 ELSE 1 END,
                duration_seconds=NULL,chapters='[]'::jsonb,details='{}'::jsonb,last_error=NULL,retry_after=NULL,updated_at=now()
            WHERE old.source_signature<>$3 OR old.extractor_version<>$4 OR
                (old.attempts<3 AND (
                    old.status='pending' OR
                    (old.status='failed' AND old.retry_after<=now()) OR
                    (old.status='processing' AND old.lease_until<now())))
            RETURNING job_token`, [id, relative, signature, version, token]);
		return rows.length ? token : undefined;
	}

	async complete(id: number, relative: string, token: string, result: AudioProbeResult): Promise<boolean> {
		const response = await PostgresAdapter.getInstance().pool.query(`
            UPDATE audio_metadata SET status=$4,duration_seconds=$5,chapters=$6::jsonb,details=$7::jsonb,
                lease_until=NULL,job_token=NULL,last_error=NULL,updated_at=now()
            WHERE archive_id=$1 AND relative_path=$2 AND job_token=$3 AND status='processing' AND lease_until>now()`,
		[id, relative, token, result.status, result.duration, JSON.stringify(result.chapters), JSON.stringify(result.details)]);
		return response.rowCount === 1;
	}

	async fail(id: number, relative: string, token: string, error: string): Promise<void> {
		await PostgresAdapter.getInstance().pool.query(`
            UPDATE audio_metadata SET status='failed',last_error=$4,job_token=NULL,lease_until=NULL,
                retry_after=now()+interval '1 hour',updated_at=now()
            WHERE archive_id=$1 AND relative_path=$2 AND job_token=$3`, [id, relative, token, error.slice(0, 4000)]);
	}

	async removeMissing(id: number, relativePaths: string[]): Promise<void> {
		await PostgresAdapter.getInstance().pool.query(
			"DELETE FROM audio_metadata WHERE archive_id=$1 AND NOT (relative_path=ANY($2::text[]))", [id, relativePaths]);
	}
}
