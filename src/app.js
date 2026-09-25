import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import routes from "./routes/index.js";
import notFound from "./middleware/notFound.js";
import errorHandler from "./middleware/errorHandler.js";
import { PROFILES_DIR, ORGS_DIR, ensureUploadDirs } from "./config/uploadPaths.js";

const app = express();

ensureUploadDirs();

app.set("trust proxy", 1);

// Important: allow cross-origin images
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

// Allow frontend origin(s)
// CORS_ORIGINS: comma-separated list, e.g. "http://localhost:5173,https://app.dverif.com"
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(cookieParser());
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// Static uploads — only profile images and org logos remain public. Uploaded
// request/employee documents are served exclusively via the authenticated
// /api/v1/documents/* route (unless a request is VERIFIED and its QR token +
// signature are presented, handled in verify.routes.js).
app.use("/uploads/profiles", express.static(PROFILES_DIR));
app.use("/uploads/organizations", express.static(ORGS_DIR));

// Public assets (logos for emails etc.)
app.use("/public", express.static(path.resolve("public")));

app.use("/api/v1", routes);

app.use(notFound);
app.use(errorHandler);

export default app;