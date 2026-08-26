import "dotenv/config";
import app from "./app.js";
import connectDB from "./config/db.js";
import { validateEnv } from "./config/env.js";

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    validateEnv();
    await connectDB();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
      console.log(`🚀 Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("📦 Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();
