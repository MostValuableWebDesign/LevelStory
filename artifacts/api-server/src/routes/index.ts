import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import journalRouter from "./journal";
import riskRouter from "./risk";
import backtestRouter from "./backtest";
import visualValidationRouter from "./visual-validation";
import authRouter from "./auth";
import governanceRouter from "./governance";
import uploadedChartRouter from "./uploaded-chart";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(marketRouter);
router.use(journalRouter);
router.use(riskRouter);
router.use(backtestRouter);
router.use(visualValidationRouter);
router.use(governanceRouter);
router.use(uploadedChartRouter);

export default router;
