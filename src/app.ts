import * as dotenv from "dotenv";
import express from "express";
import compression from "compression";
import lusca from "lusca";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { schedule } from "node-cron";
import moment from "moment-timezone";

import { Logger } from "(src)/helpers/Logger";
import RedisAdapter from "(src)/db/RedisAdapter";
import { BooksService } from "(src)/services/BooksService";
import { config } from "(src)/config/configuration";
import * as homeController from "(src)/controllers/home";

dotenv.config({path: ".env"});

export async function bootstrap(): Promise<express.Express> {
	const logger = new Logger("App");

	const app = express();

	app.use(helmet());
	app.use(compression());

	app.use(express.json());
	app.use(express.urlencoded({extended: true}));

	await RedisAdapter.initialize().catch((err) => {
		logger.error("Error initializing RedisAdapter:", err);
		throw new Error("Failed to initialize RedisAdapter");
	});

	app.use(cors());
	app.use(lusca.xframe("SAMEORIGIN"));
	app.use(lusca.xssProtection(true));

	app.set("port", config.production.server.port);
	app.use(express.static(path.join(__dirname, "public"), {maxAge: 31557600000}));

	app.get("/", homeController.index);
	app.get("/check/:action", homeController.checkParameter);

	schedule(
		config.production.scan.cron,
		async () => {
			logger.info(`Executing update book info cron at ${moment(new Date()).tz("America/Lima").format("LLLL")}`);
			BooksService
				.getInstance()
				.cronUpdateBooksInfo()
				.catch((error: any) => {
					logger.error("Executing update book info cron:", error);
				})
			;
		},
		{
			timezone: "America/Lima"
		}
	);

	return app;
}
