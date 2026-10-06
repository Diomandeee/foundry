import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, worker: "api" }));

// Phase 2/3: board state from D1 decisions; why-trail per merge;
// git-history.json for the Spatial Git view.
app.get("/decisions", async (c) =>
  c.json({ error: "not implemented (Phase 2)" }, 501),
);
app.get("/why/:merge", async (c) =>
  c.json({ error: "not implemented (Phase 2)" }, 501),
);
app.get("/history.json", async (c) =>
  c.json({ error: "not implemented (Phase 3)" }, 501),
);

export default app;
