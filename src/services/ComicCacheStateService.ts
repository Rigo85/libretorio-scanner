import fs from "fs-extra";
import path from "path";

import { Logger } from "(src)/helpers/Logger";
import { ComicCacheState } from "(src)/models/interfaces/ComicCacheState";
import { ComicArchiveFormat, ComicSourceType, EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";

const logger = new Logger("ComicCacheState");

interface BaseStateInput {
	sourcePath: string;
	sourceType: ComicSourceType;
	archiveFormat?: ComicArchiveFormat;
	fileHash?: string;
}

type BaseStateOutput = Omit<
ComicCacheState,
"status" | "buildOutcome" | "chunkCount" | "totalPages" | "zipReady" | "chunksReady" | "droppedPages" | "warningCount" | "lastWarnings" | "lastError"
>;

export class ComicCacheStateService {
	private static instance: ComicCacheStateService;

	private constructor() {
	}

	public static getInstance(): ComicCacheStateService {
		if (!ComicCacheStateService.instance) {
			ComicCacheStateService.instance = new ComicCacheStateService();
		}
		return ComicCacheStateService.instance;
	}

	public async read(statePath: string): Promise<ComicCacheState | undefined> {
		try {
			if (!(await fs.pathExists(statePath))) {
				return undefined;
			}

			return JSON.parse(await fs.readFile(statePath, "utf8")) as ComicCacheState;
		} catch (error) {
			logger.error(`read "${statePath}":`, error);
			return undefined;
		}
	}

	public async write(statePath: string, state: ComicCacheState): Promise<void> {
		await fs.ensureDir(path.dirname(statePath));
		await fs.writeFile(statePath, JSON.stringify(state, undefined, 2));
	}

	public async markBuilding(statePath: string, source: EligibleComicSource): Promise<ComicCacheState> {
		const previous = await this.read(statePath);
		const nextState = this.buildBaseState({
			sourcePath: source.sourcePath,
			sourceType: source.sourceType,
			archiveFormat: source.archiveFormat,
			fileHash: source.fileHash
		}, previous);

		const state: ComicCacheState = {
			...nextState,
			status: "building",
			buildOutcome: undefined,
			chunkCount: 0,
			totalPages: 0,
			zipReady: false,
			chunksReady: false,
			droppedPages: undefined,
			warningCount: undefined,
			lastWarnings: undefined,
			lastError: undefined
		};

		await this.write(statePath, state);
		return state;
	}

	public async markReady(
		statePath: string,
		source: EligibleComicSource,
		payload: {
			chunkCount: number;
			totalPages: number;
			zipReady: boolean;
			buildOutcome?: "complete" | "partial";
			droppedPages?: number;
			warningCount?: number;
			lastWarnings?: string[];
		}
	): Promise<ComicCacheState> {
		const previous = await this.read(statePath);
		const nextState = this.buildBaseState({
			sourcePath: source.sourcePath,
			sourceType: source.sourceType,
			archiveFormat: source.archiveFormat,
			fileHash: source.fileHash
		}, previous);

		const state: ComicCacheState = {
			...nextState,
			status: "ready",
			buildOutcome: payload.buildOutcome || "complete",
			chunkCount: payload.chunkCount,
			totalPages: payload.totalPages,
			zipReady: payload.zipReady,
			chunksReady: true,
			droppedPages: payload.droppedPages || 0,
			warningCount: payload.warningCount || 0,
			lastWarnings: payload.lastWarnings?.slice(0, 5),
			lastError: undefined
		};

		await this.write(statePath, state);
		return state;
	}

	public async markError(
		statePath: string,
		source: BaseStateInput,
		errorMessage: string
	): Promise<ComicCacheState> {
		const previous = await this.read(statePath);
		const nextState = this.buildBaseState({
			sourcePath: source.sourcePath,
			sourceType: source.sourceType,
			archiveFormat: source.archiveFormat,
			fileHash: source.fileHash
		}, previous);

		const state: ComicCacheState = {
			...nextState,
			status: "error",
			buildOutcome: undefined,
			chunkCount: 0,
			totalPages: 0,
			zipReady: false,
			chunksReady: false,
			droppedPages: undefined,
			warningCount: undefined,
			lastWarnings: undefined,
			lastError: errorMessage
		};

		await this.write(statePath, state);
		return state;
	}

	private buildBaseState(
		input: BaseStateInput,
		previous?: ComicCacheState
	): BaseStateOutput {
		const now = new Date().toISOString();

		return {
			version: 1,
			sourcePath: input.sourcePath,
			sourceType: input.sourceType,
			archiveFormat: input.archiveFormat,
			fileHash: input.fileHash,
			createdAt: previous?.createdAt || now,
			updatedAt: now
		};
	}
}
