import { Request, Response, NextFunction } from "express";

export const index = async (req: Request, res: Response, next: NextFunction) => {
	res.end("Ok");
};
