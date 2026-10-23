import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const server = await startServer({ port, host });
const shutdown = () => { void server.close().then(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
