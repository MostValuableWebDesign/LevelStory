import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { rejectPrivateFilePaths, securityHeaders } from "./lib/security";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(securityHeaders);
app.use(rejectPrivateFilePaths);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, false);
      return;
    }
    const allowed = (process.env.LEVELSTORY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    callback(null, allowed.includes(origin) ? origin : false);
  },
  credentials: false,
}));
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.use("/api", router);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const typed = error as { type?: string; status?: number };
  if (typed.type === "entity.too.large" || typed.status === 413) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }
  if (typed.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON request body." });
    return;
  }
  res.status(500).json({ error: "Internal server error." });
});

export default app;
