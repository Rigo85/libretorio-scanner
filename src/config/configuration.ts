import path from "path";
import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

export const config = {
	production: {
		db: {
			databaseUrl: process.env.DATABASE_URL,
			redisUrl: process.env.REDIS_URL
		},
		server: {
			port: parseInt(process.env.PORT || "3006"),
			environment: process.env.NODE_ENV || "development"
		},
		paths: {
			scanRoot: path.join(__dirname, "..", "public", "books")
		},
		scan: {
			openLibrary: (process.env.CAN_USE_OPENLIBRARY_API || "false").toLowerCase() === "true",
			cron: process.env.CRON_SCHEDULE || "0 */1 * * *",
			action: process.env.ACTION || "update-books-info"
		}
	},
	development: {}
};
