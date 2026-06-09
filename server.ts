import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API route for proxying Google Drive fetch
  app.get("/api/fetch-drive", async (req, res) => {
    try {
      const driveUrl = "https://drive.google.com/uc?export=download&id=1V3M3kcg-ZDGmNK_TwzOx_9AzviWyumxI";
      const response = await fetch(driveUrl);
      
      if (!response.ok) {
        return res.status(response.status).send(`Failed to fetch from Drive: ${response.statusText}`);
      }
      
      const txt = await response.text();
      res.send(txt);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
