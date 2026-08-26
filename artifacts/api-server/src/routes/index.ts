import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import journalRouter from "./journal";
import riskRouter from "./risk";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketRouter);
router.use(journalRouter);
router.use(riskRouter);

export default router;
