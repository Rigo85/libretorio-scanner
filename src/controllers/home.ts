import { Request, Response, NextFunction } from "express";
import { config } from "(src)/config/configuration";
import { BooksService } from "(src)/services/BooksService";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("home");

export const index = async (req: Request, res: Response, next: NextFunction) => {
	res.end("Ok");
};

export const checkParameter = async (req: Request, res: Response, next: NextFunction) => {
	const action = req.params.action || req.query.action;


	if (action === config.production.scan.action) {
		try {
			BooksService
				.getInstance()
				.cronUpdateBooksInfo()
				.catch((error: any) => {
					logger.error("Executing update book info cron:", error);
				})
			;

			return res.status(200).json({message: "Valid parameter", success: true});
		} catch (error) {
			logger.error("Executing update book info:", error);

			return res.status(400).json({message: "Invalid parameter", success: false});
		}
	}
	return res.status(400).json({message: "Invalid parameter", success: false});

};
